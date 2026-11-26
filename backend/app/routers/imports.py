import hashlib
import json
from collections import Counter
from datetime import timedelta

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import delete, func, select

from app.deps import DB, CurrentUser
from app.importers import BANK_LABELS, ImportFormatError, parse_statement, row_hash
from app.models import (
    Shop,
    SAVING_TYPES,
    TRANSFER_TYPES,
    BankAccount,
    Category,
    ImportBatch,
    SavingsGoal,
    Transaction,
    TransactionType,
)
from app.schemas import (
    ImportBatchOut,
    ImportCommitIn,
    ImportCommitOut,
    ImportFileIn,
    ImportFileInfo,
    ImportPreview,
    ImportRow,
    from_cents,
    to_cents,
)
from app.services.categorize import Categorizer, Suggestion, TxText
from app.services.import_links import (
    REVOLUT_OWN,
    REVOLUT_REFUND,
    REFUND_LINK_DAYS,
    ExchangeSide,
    RefundCand,
    best_refund,
    exchange_currency,
    pair_exchanges,
)
from app.services.currency import BASE, norm_code, orig_cents, set_amount, to_pln, user_rates
from app.services.groups import make_group
from app.services.identity import AccountIndex, account_numbers, fold
from app.services.balances import BTx, end_of_day_balances
from app.services.duplicates import Entry, find_duplicates, find_similar, tokens_for
from app.services.recurring import detect as detect_recurring
from app.services.shops import assign_rule_shop, resolve_shop
from app.services.learning import LearnKey, Target, learn_key, proposal_for_rule, upsert_rule
from app.services.similarity import SIMILAR_DAYS, words_of
from app.services.transfers import Side, _words, account_words, find_pairs, is_own_transfer_type, unlink_pairs

router = APIRouter(prefix="/api/import", tags=["import"])

MAX_FILE_SIZE = 10 * 1024 * 1024
MAX_FILES = 12
OUT_TYPES = {TransactionType.expense, TransactionType.saving_deposit, TransactionType.transfer_out}


DUPLICATE_REASONS = {
    "exact": "ta sama kwota, dzień i rachunek",
    "probable": "ta sama kwota, bliska data i podobny opis",
    "possible": "ta sama kwota i data (±1 dzień), inny opis",
}


def _mark_pair(row: ImportRow, target: BankAccount | None, categorizer: Categorizer, reason: str) -> None:
    """Oznacza wiersz jako stronę przelewu własnego na/z konta `target`."""
    if row.type in SAVING_TYPES and row.savings_goal_id:
        row.reason = reason
        return
    sug = categorizer._transfer(TxText(description=row.description, amount=row.amount), target, reason)
    row.type = sug.type
    row.category_id = None
    row.savings_goal_id = sug.savings_goal_id
    row.transfer_account_id = sug.transfer_account_id
    row.reason = reason


@router.get("/banks")
def banks():
    return [{"id": k, "label": v} for k, v in BANK_LABELS.items()]


def _parse_account_ids(raw: str | None, n: int) -> list[int | None]:
    """`account_ids` to lista JSON (np. "[3, null]") albo wartości po przecinku, zgodna z kolejnością plików."""
    if not raw:
        return [None] * n
    try:
        values = json.loads(raw)
        if not isinstance(values, list):
            values = [values]
    except json.JSONDecodeError:
        values = [v.strip() for v in raw.split(",")]
    out: list[int | None] = []
    for v in values[:n]:
        try:
            out.append(int(v) if v not in (None, "", "null") else None)
        except (TypeError, ValueError):
            out.append(None)
    return out + [None] * (n - len(out))


@router.post("/preview", response_model=ImportPreview)
async def preview(
    db: DB,
    user: CurrentUser,
    files: list[UploadFile] | None = File(None),
    file: UploadFile | None = File(None),
    bank: str = Form("auto"),
    account_id: int | None = Form(None),
    account_ids: str | None = Form(None),
):
    """Analizuje jeden lub kilka wyciągów CSV. Niczego nie zapisuje — zwraca wiersze
    do weryfikacji z podpowiedziami kategorii i oznaczonymi duplikatami."""
    uploads = list(files or []) + ([file] if file else [])
    if not uploads:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Nie przesłano pliku")
    if len(uploads) > MAX_FILES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Maksymalnie {MAX_FILES} plików naraz")
    acc_ids = _parse_account_ids(account_ids, len(uploads))
    if account_id is not None and len(uploads) == 1 and acc_ids[0] is None:
        acc_ids[0] = account_id

    accounts = db.scalars(select(BankAccount).where(BankAccount.user_id == user.id)).all()
    acc_by_id = {a.id: a for a in accounts}
    index = AccountIndex(list(accounts))
    rates = user_rates(db, user.id)
    categorizer = Categorizer(db, user.id)

    infos: list[ImportFileInfo] = []
    rows: list[ImportRow] = []
    entries: list[Entry] = []
    pair_words: list[set[str]] = []  # słowa do parowania przelewów własnych (z typem operacji z banku)
    row_kinds: list[str | None] = []  # typ operacji Revolut (kolumna „Type”) albo None
    for idx, up in enumerate(uploads):
        info = ImportFileInfo(index=idx, filename=up.filename or f"plik {idx + 1}")
        infos.append(info)
        data = await up.read()
        if len(data) > MAX_FILE_SIZE:
            info.error = "Plik jest za duży (maks. 10 MB)"
            continue
        try:
            result = parse_statement(data, bank)
        except ImportFormatError as e:
            info.error = str(e)
            continue
        info.bank, info.bank_label = result.bank, BANK_LABELS[result.bank]
        info.skipped_lines = result.skipped_lines
        info.warnings = list(result.warnings)

        chosen = acc_by_id.get(acc_ids[idx]) if acc_ids[idx] else None
        if acc_ids[idx] and chosen is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono rachunku")
        detected = index.by_statement(result.statement_accounts)
        if chosen is None and detected is not None:
            chosen, info.account_detected = detected, True
        elif chosen is None and not result.statement_accounts:
            # bez numeru w pliku (np. Revolut): jedyne konto główne tego banku
            same_bank = [a for a in accounts if a.bank == result.bank and a.parent_id is None and not a.archived]
            if len(same_bank) == 1:
                chosen, info.account_detected = same_bank[0], True
        elif chosen and detected is not None and index.root(detected).id != index.root(chosen).id:
            info.warnings.append(
                f"Wybrany rachunek „{chosen.name}” ma inny numer niż rachunek zapisany w pliku — upewnij się, że to właściwy wyciąg."
            )
        elif chosen and result.statement_accounts and detected is None and account_numbers(chosen):
            info.warnings.append(
                f"Wybrany rachunek „{chosen.name}” ma inny numer niż rachunek zapisany w pliku — upewnij się, że to właściwy wyciąg."
            )
        if chosen and chosen.bank not in ("other", result.bank) and result.bank != "screenshot":
            info.warnings.append(f"Rachunek „{chosen.name}” jest oznaczony jako inny bank niż wykryty format pliku.")
        info.account_id = chosen.id if chosen else None
        info.statement_account = result.statement_accounts[0] if result.statement_accounts else None

        def row_account(r) -> int | None:
            """Konto wiersza: rachunek z wiersza (wyciąg z kilku kont) → subkonto w walucie / produkcie."""
            base = chosen
            if r.account_number:
                own = index.by_statement([r.account_number], r.currency)
                if own is not None:
                    base = own
            if base is None:
                return None
            cur = norm_code(r.currency)
            if base.is_group or r.product or cur != norm_code(base.currency):
                sub = index.for_currency(base, cur, r.product)
                if sub is not None:
                    return sub.id
                if (base.is_group or cur != norm_code(base.currency)) and cur not in info.missing_subaccounts:
                    info.missing_subaccounts.append(cur)
            return base.id

        savings_skipped = 0
        parsed = list(result.rows)
        for r in result.savings_rows:
            base = chosen
            sub = index.for_currency(base, r.currency, r.product) if base is not None else None
            if sub is None:
                savings_skipped += 1
            else:
                parsed.append(r)
        if savings_skipped:
            info.warnings.append(
                f"Pominięto {savings_skipped} operacji w skarbonkach Revolut (wpłaty do nich widać jako przelewy z "
                "rachunku głównego). Dodaj rachunek z produktem „Savings”, żeby je importować."
            )

        seen: Counter[str] = Counter()
        for r in parsed:
            if r.amount == 0:
                continue
            r_acc = row_account(r)
            cents_pln = to_pln(to_cents(r.amount), r.currency, rates)
            base = row_hash(result.bank, r, 0)
            occurrence = seen[base]
            seen[base] += 1
            h = base if occurrence == 0 else row_hash(result.bank, r, occurrence)
            sug = categorizer.suggest(
                TxText(
                    description=r.description,
                    amount=float(r.amount),
                    title=r.title,
                    counterparty=r.counterparty,
                    counterparty_account=r.counterparty_account,
                    raw_type=r.raw_type,
                    currency=r.currency,
                    phone=r.phone,
                ),
                r_acc,
            )
            # Revolut: o charakterze operacji decyduje kolumna „Type”, nie reguły
            kind = r.kind if result.bank == "revolut" else None
            if kind in REVOLUT_OWN:
                target = None
                if kind == "exchange":
                    other_cur = exchange_currency(r.description)
                    base_acc = acc_by_id.get(r_acc) if r_acc else None
                    if other_cur and base_acc is not None and other_cur != norm_code(r.currency):
                        cand = index.for_currency(base_acc, other_cur, r.product)
                        if cand is not None and norm_code(cand.currency) == other_cur and cand.id != r_acc:
                            target = cand
                label = "wymiana walut" if kind == "exchange" else "doładowanie (Topup)"
                sug = categorizer._transfer(
                    TxText(description=r.description, amount=float(r.amount)),
                    target,
                    f"Revolut: {label} — przelew własny" + (f" ({target.name})" if target else ""),
                )
            elif kind in REVOLUT_REFUND and r.amount > 0:
                sug = Suggestion(type=TransactionType.income, reason="Revolut: zwrot (Card refund)")
            row = ImportRow(
                file_index=idx,
                date=r.date,
                amount=float(r.amount),
                description=r.description,
                title=r.title or None,
                counterparty=r.counterparty or None,
                counterparty_account=r.counterparty_account,
                currency=norm_code(r.currency),
                amount_pln=from_cents(cents_pln),
                balance=float(r.balance) if r.balance is not None else None,
                account_id=r_acc if r_acc != info.account_id else None,
                product=r.product,
                type=sug.type,
                category_id=sug.category_id,
                savings_goal_id=sug.savings_goal_id,
                transfer_account_id=sug.transfer_account_id,
                shop_id=sug.shop_id,
                raw_type=r.raw_type or None,
                reason=sug.reason,
                hash=h,
            )
            key = learn_key(r.counterparty, r.description)
            if key:
                row.learn_field, row.learn_pattern = key.field.value, key.pattern
            entries.append(
                Entry(
                    key=("row", len(rows)),
                    date=r.date,
                    cents=cents_pln,
                    account_id=r_acc,
                    hash=h,
                    tokens=tokens_for(r.description, r.counterparty, r.title),
                    file_index=idx,
                    words=words_of(r.description, r.counterparty, r.title),
                    category_id=sug.category_id,
                    info={
                        "source": "file",
                        "file_index": idx,
                        "filename": info.filename,
                        "date": r.date.isoformat(),
                        "amount": float(r.amount),
                        "description": r.description,
                    },
                )
            )
            rows.append(row)
            row_kinds.append(kind)
            pair_words.append(_words(r.description, r.title, r.counterparty, r.raw_type))
        file_rows = [r for r in rows if r.file_index == idx]
        info.row_count = len(file_rows)
        if file_rows:
            info.date_from = min(r.date for r in file_rows)
            info.date_to = max(r.date for r in file_rows)
            info.currencies = sorted({r.currency for r in file_rows})
            info.missing_rates = [c for c in info.currencies if c != BASE and c not in rates]
            main_cur = norm_code(chosen.currency) if chosen else None
            main_rows = [r for r in file_rows if r.account_id is None and r.balance is not None]
            if main_rows:
                eod = end_of_day_balances(
                    [BTx(i, r.date, to_cents(r.amount), to_cents(r.balance), r.currency, r.type, None) for i, r in enumerate(main_rows)],
                    main_cur,
                )
                if eod:
                    info.closing_balance = from_cents(eod[max(eod)])
            q = select(func.count()).where(
                Transaction.user_id == user.id,
                Transaction.date >= info.date_from,
                Transaction.date <= info.date_to,
            )
            if info.account_id:
                ids = {info.account_id} | {r.account_id for r in file_rows if r.account_id}
                q = q.where(Transaction.account_id.in_(ids))
            info.existing_in_range = db.scalar(q) or 0

    # --- duplikaty: baza + wcześniejsze pliki tego samego importu
    if rows:
        lo = min(r.date for r in rows) - timedelta(days=SIMILAR_DAYS)
        hi = max(r.date for r in rows) + timedelta(days=SIMILAR_DAYS)
        existing = db.scalars(
            select(Transaction).where(Transaction.user_id == user.id, Transaction.date >= lo, Transaction.date <= hi)
        ).unique().all()
        db_entries = [
            Entry(
                key=("db", t.id),
                date=t.date,
                cents=-t.amount_cents if t.type in OUT_TYPES else t.amount_cents,
                account_id=t.account_id,
                hash=t.import_hash,
                tokens=tokens_for(t.description, t.counterparty, t.title),
                words=words_of(t.description, t.counterparty, t.title),
                category_id=t.category_id,
                info={
                    "source": "db",
                    "id": t.id,
                    "date": t.date.isoformat(),
                    "amount": from_cents(-t.amount_cents if t.type in OUT_TYPES else t.amount_cents),
                    "description": t.description,
                    "account_name": t.account.name if t.account else None,
                    "category_name": t.category.name if t.category else None,
                    "source_bank": t.source,
                },
            )
            for t in existing
        ]
        matched = find_duplicates(entries, db_entries)
        for key, (level, info_) in matched.items():
            row = rows[key[1]]
            row.duplicate = level
            row.duplicate_of = info_
            row.duplicate_reason = DUPLICATE_REASONS[level]
            # pewny duplikat (kwota + dzień + konto) domyślnie pomijamy, podobne — domyślnie dodajemy
            row.include = level != "exact"
        # reguły podobieństwa (ta sama kwota + data / wspólne słowo / kategoria w ciągu 2 tygodni)
        for key, (reason, info_) in find_similar(entries, db_entries, set(matched)).items():
            row = rows[key[1]]
            row.duplicate = "similar"
            row.duplicate_of = info_
            row.duplicate_reason = reason

        # --- przelewy własne: druga strona w innym pliku tego importu albo w bazie
        acc_words = {a.id: account_words(a, BANK_LABELS.get(a.bank)) for a in accounts}
        row_acc = lambda r: r.account_id or infos[r.file_index].account_id  # noqa: E731
        # Revolut „Exchange”: obie strony wymiany są w tym samym pliku (różne waluty, ten sam dzień)
        ex_sides = [
            ExchangeSide(i, r.file_index, r.date, to_cents(r.amount), r.currency, exchange_currency(r.description))
            for i, r in enumerate(rows)
            if row_kinds[i] == "exchange" and r.duplicate != "exact"
        ]
        no_pair: set[int] = {i for i, k in enumerate(row_kinds) if k is not None and k not in REVOLUT_OWN}
        for a_i, b_i in pair_exchanges(ex_sides):
            ra, rb = rows[a_i], rows[b_i]
            acc_a, acc_b = row_acc(ra), row_acc(rb)
            note = f"Revolut: wymiana walut {ra.amount:.2f} {ra.currency} → {rb.amount:.2f} {rb.currency}".replace(".", ",")
            _mark_pair(ra, acc_by_id.get(acc_b) if acc_b != acc_a else None, categorizer, note)
            _mark_pair(rb, acc_by_id.get(acc_a) if acc_b != acc_a else None, categorizer, note)
            ra.pair_hash, rb.pair_hash = rb.hash, ra.hash
            no_pair.update((a_i, b_i))
        # Revolut „Card refund”: zwrot wiążemy z pasującym wydatkiem (w bazie albo w tym imporcie)
        refund_rows = [i for i, k in enumerate(row_kinds) if k in REVOLUT_REFUND and rows[i].amount > 0 and rows[i].duplicate != "exact"]
        if refund_rows:
            lo_r = min(rows[i].date for i in refund_rows) - timedelta(days=REFUND_LINK_DAYS)
            hi_r = max(rows[i].date for i in refund_rows)
            exps = db.scalars(
                select(Transaction).where(
                    Transaction.user_id == user.id,
                    Transaction.type == TransactionType.expense,
                    Transaction.date >= lo_r,
                    Transaction.date <= hi_r,
                ).order_by(Transaction.id)
            ).unique().all()
            done = dict(
                db.execute(
                    select(Transaction.refund_of_id, func.sum(Transaction.amount_cents))
                    .where(Transaction.user_id == user.id, Transaction.refund_of_id.is_not(None))
                    .group_by(Transaction.refund_of_id)
                ).all()
            )
            cands = [
                RefundCand(("db", e.id), e.date, e.amount_cents, orig_cents(e), norm_code(e.currency),
                           e.amount_cents - done.get(e.id, 0), words_of(e.description, e.counterparty, e.title))
                for e in exps
            ] + [
                RefundCand(("row", j), x.date, -entries[j].cents, -to_cents(x.amount), x.currency, -entries[j].cents,
                           words_of(x.description, x.counterparty, x.title))
                for j, x in enumerate(rows)
                if x.amount < 0 and x.type == TransactionType.expense and x.duplicate != "exact"
            ]
            for i in refund_rows:
                r = rows[i]
                c = best_refund(r.date, entries[i].cents, to_cents(r.amount), r.currency, words_of(r.description, r.counterparty), cands)
                if c is None:
                    continue
                c.remaining -= entries[i].cents
                if c.key[0] == "db":
                    e = next(x for x in exps if x.id == c.key[1])
                    r.refund_of_id = e.id
                    label = f"{e.description} ({e.date.strftime('%d.%m.%Y')})"
                else:
                    x = rows[c.key[1]]
                    r.refund_of_hash = x.hash
                    label = f"{x.description} ({x.date.strftime('%d.%m.%Y')}, ten import)"
                r.refund_of_label = label[:200]
                r.category_id = None
                r.reason = f"zwrot do: {label}"[:300]
        row_sides = [
            Side(
                key=("row", i),
                account_id=row_acc(r),  # type: ignore[arg-type]
                date=r.date,
                cents=entries[i].cents,
                is_transfer=is_own_transfer_type(r.type),
                words=pair_words[i],
                tokens=entries[i].tokens,
                currency=r.currency,
                orig=to_cents(r.amount),
            )
            for i, r in enumerate(rows)
            if row_acc(r) and r.duplicate != "exact" and i not in no_pair
        ]
        db_by_id = {t.id: t for t in existing}
        db_sides = [
            Side(
                key=("db", t.id),
                account_id=t.account_id,  # type: ignore[arg-type]
                date=t.date,
                cents=-t.amount_cents if t.type in OUT_TYPES else t.amount_cents,
                is_transfer=t.type in TRANSFER_TYPES,
                words=_words(t.description, t.title, t.counterparty),
                tokens=tokens_for(t.description, t.counterparty, t.title),
                currency=norm_code(t.currency),
                orig=-orig_cents(t) if t.type in OUT_TYPES else orig_cents(t),
            )
            for t in existing
            if t.account_id
            and t.pair_id is None
            and (t.type in (TransactionType.expense, TransactionType.income) or (t.type in TRANSFER_TYPES and t.transfer_account_id is None))
        ]
        for a, b in find_pairs(row_sides, db_sides, acc_words):
            ra = rows[a.key[1]]
            target = acc_by_id.get(b.account_id)
            if b.key[0] == "row":
                rb = rows[b.key[1]]
                if rb.file_index == ra.file_index:  # np. wymiana walut między subkontami Revolut
                    _mark_pair(ra, target, categorizer, f"przelew własny — {target.name if target else 'inny rachunek'}")
                    _mark_pair(rb, acc_by_id.get(a.account_id), categorizer, f"przelew własny — {acc_by_id[a.account_id].name}")
                else:
                    _mark_pair(ra, target, categorizer, f"przelew własny — para z plikiem „{infos[rb.file_index].filename}”")
                    _mark_pair(rb, acc_by_id.get(a.account_id), categorizer, f"przelew własny — para z plikiem „{infos[ra.file_index].filename}”")
                ra.pair_hash, rb.pair_hash = rb.hash, ra.hash
            else:
                t = db_by_id[b.key[1]]
                when = t.date.strftime("%d.%m.%Y")
                _mark_pair(ra, target, categorizer, f"przelew własny — druga strona już jest: {when}, {target.name if target else 'inny rachunek'}")
                ra.pair_tx_id = t.id

    warnings: list[str] = []
    ok_files = [i for i in infos if not i.error]
    missing_rates = sorted({c for i in ok_files for c in i.missing_rates})
    if missing_rates:
        warnings.append(
            f"Brak kursu dla: {', '.join(missing_rates)} — do czasu ustawienia kursu (Ustawienia → Waluty) kwoty "
            "liczone są 1:1. Po ustawieniu kursu wszystko przeliczy się samo."
        )
    for i in ok_files:
        if i.missing_subaccounts and i.account_id:
            name = acc_by_id[i.account_id].name
            file_acc = db.get(BankAccount, i.account_id)
            if file_acc is not None and not file_acc.is_group and file_acc.parent_id is None:
                curs = [norm_code(file_acc.currency)] + [c for c in i.missing_subaccounts if c != norm_code(file_acc.currency)]
                warnings.append(
                    f"„{i.filename}”: wyciąg ma kilka walut, więc „{name}” stanie się bankiem (grupą) z rachunkami "
                    f"{', '.join(f'„{name} {c}”' for c in curs)} — każda waluta będzie miała osobne saldo."
                )
            else:
                warnings.append(
                    f"„{i.filename}”: dla operacji w {', '.join(i.missing_subaccounts)} przy zatwierdzeniu powstanie "
                    f"rachunek w banku „{name}” (saldo każdej waluty liczy się osobno)."
                )
    if not rows:
        warnings.append("Nie znaleziono żadnych transakcji w przesłanych plikach.")
    counts = Counter(r.duplicate for r in rows if r.duplicate)
    if counts["exact"]:
        warnings.append(
            f"{counts['exact']} transakcji to duplikaty — ta sama kwota, dzień i rachunek są już w bazie lub w innym z "
            "przesłanych plików. Domyślnie zostaną pominięte, ale możesz je dodać mimo to."
        )
    similar = counts["probable"] + counts["possible"] + counts["similar"]
    if similar:
        warnings.append(
            f"{similar} transakcji jest podobnych do już zapisanych (ta sama kwota, ale inny dzień, opis lub rachunek) — "
            "oznaczyliśmy je, ale zostaną dodane; przy zatwierdzaniu możesz je pominąć."
        )
    pairs = sum(1 for r in rows if r.pair_hash or r.pair_tx_id)
    if pairs:
        warnings.append(f"Sparowano {pairs} stron(y) przelewów między Twoimi rachunkami (wypływ z jednego, wpływ na drugie).")
    transfers = sum(1 for r in rows if r.type in TRANSFER_TYPES)
    if transfers:
        warnings.append(f"Rozpoznano {transfers} przelew(y) między Twoimi rachunkami — nie będą liczone jako wydatki ani wpływy.")
    if not ok_files:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, infos[0].error or "Nie udało się odczytać pliku")

    first = ok_files[0]
    return ImportPreview(
        files=infos,
        rows=rows,
        warnings=warnings,
        bank=first.bank or "",
        bank_label=first.bank_label or "",
        filename=first.filename,
        account_id=first.account_id,
        account_detected=first.account_detected,
        skipped_lines=sum(i.skipped_lines for i in ok_files),
    )


@router.post("/commit", response_model=ImportCommitOut)
def commit(data: ImportCommitIn, db: DB, user: CurrentUser):
    """Zapisuje zatwierdzone wiersze. Każdy plik to osobna paczka (można ją cofnąć).
    Wiersze identyczne z już zaimportowanymi są zawsze pomijane."""
    files = data.files
    if not files:
        if not data.bank:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Brak informacji o pliku")
        files = [ImportFileIn(filename=data.filename, bank=data.bank, account_id=data.account_id)]
    for f in files:
        if f.bank not in BANK_LABELS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nieobsługiwany bank")

    cat_ids = {
        cid: kind
        for cid, kind in db.execute(select(Category.id, Category.kind).where(Category.user_id == user.id)).all()
    }
    goal_ids = set(db.scalars(select(SavingsGoal.id).where(SavingsGoal.user_id == user.id)))
    shop_ids = set(db.scalars(select(Shop.id).where(Shop.user_id == user.id)))
    account_ids = set(db.scalars(select(BankAccount.id).where(BankAccount.user_id == user.id)))
    for f in files:
        if f.account_id is not None and f.account_id not in account_ids:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono rachunku")
    existing = set(
        db.scalars(select(Transaction.import_hash).where(Transaction.user_id == user.id, Transaction.import_hash.is_not(None)))
    )
    # ponowny import tego samego wyciągu uzupełnia saldo w transakcjach zapisanych przed tą funkcją
    missing_balance = {
        r.hash: r.balance for r in data.rows if r.balance is not None and r.hash in existing
    }
    if missing_balance:
        for t in db.scalars(
            select(Transaction).where(
                Transaction.user_id == user.id,
                Transaction.import_hash.in_(list(missing_balance)),
                Transaction.balance_cents.is_(None),
            )
        ).unique():
            t.balance_cents = to_cents(missing_balance[t.import_hash])

    batches: list[ImportBatch] = []
    for f in files:
        b = ImportBatch(user_id=user.id, bank=f.bank, account_id=f.account_id, filename=f.filename[:255])
        db.add(b)
        batches.append(b)
    db.flush()

    rates = user_rates(db, user.id)
    own_accounts = list(db.scalars(select(BankAccount).where(BankAccount.user_id == user.id)))
    index = AccountIndex(own_accounts)
    created_subs: list[BankAccount] = []

    def base_account(r) -> int | None:
        return r.account_id if r.account_id in account_ids else files[r.file_index if 0 <= r.file_index < len(files) else 0].account_id

    # wyciąg wielowalutowy na zwykłe konto (np. Revolut bez subkont): konto staje się folderem,
    # a jego dotychczasowe operacje trafiają do subkonta w jego walucie
    to_group: dict[int, BankAccount] = {}
    for r in data.rows:
        acc = index.by_id.get(base_account(r) or 0)
        if not r.include or acc is None or acc.is_group or norm_code(r.currency) == norm_code(acc.currency):
            continue
        root = index.root(acc)
        if not root.is_group and index.for_currency(acc, r.currency, r.product) is None:
            to_group[root.id] = root
    for root in to_group.values():
        moved = make_group(db, root)
        if moved is not None and moved not in own_accounts:
            own_accounts.append(moved)
            created_subs.append(moved)
            account_ids.add(moved.id)
    if to_group:
        db.flush()
        index = AccountIndex(own_accounts)

    def currency_account(acc_id: int | None, currency: str, product: str | None) -> int | None:
        """Subkonto w walucie wiersza; gdy go brak — zakładamy je pod kontem głównym (folderem)."""
        nonlocal index
        if acc_id is None:
            return None
        acc = index.by_id.get(acc_id)
        cur = norm_code(currency)
        if acc is None or (not acc.is_group and cur == norm_code(acc.currency) and not product):
            return acc_id
        sub = index.for_currency(acc, cur, product)
        if sub is not None:
            return sub.id
        if not acc.is_group and cur == norm_code(acc.currency):
            return acc_id  # np. produkt „Current” na koncie w tej samej walucie
        root = index.root(acc)
        if not root.is_group:
            return acc_id  # (nie powinno się zdarzyć — konta do zamiany obsłużone wyżej)
        prod = product if product and fold(product) not in ("current", "") else None
        sub = BankAccount(
            user_id=user.id,
            name=f"{root.name} {cur}" + (f" · {prod}" if prod else ""),
            bank=root.bank,
            color=root.color,
            currency=cur,
            parent_id=root.id,
            product=prod,
        )
        db.add(sub)
        db.flush()
        own_accounts.append(sub)
        created_subs.append(sub)
        index = AccountIndex(own_accounts)
        account_ids.add(sub.id)
        return sub.id

    imported = [0] * len(files)
    skipped = [0] * len(files)
    new_by_hash: dict[str, Transaction] = {}
    # zwroty z importu: tylko do Twoich wydatków
    refund_ids = {r.refund_of_id for r in data.rows if r.refund_of_id}
    refund_ok = set(
        db.scalars(
            select(Transaction.id).where(
                Transaction.user_id == user.id, Transaction.id.in_(refund_ids), Transaction.type == TransactionType.expense
            )
        ).all()
    ) if refund_ids else set()
    for r in data.rows:
        fi = r.file_index if 0 <= r.file_index < len(files) else 0
        f, batch = files[fi], batches[fi]
        if not r.include:
            skipped[fi] += 1
            continue
        # duplikat dodany świadomie: ten sam wiersz wyciągu jest już w bazie — zapisujemy go pod
        # pochodnym odciskiem, żeby nie łamać unikalności (ponowny import i tak wykryje oba)
        stored_hash = r.hash
        n = 1
        while stored_hash in existing:
            stored_hash = hashlib.sha256(f"{r.hash}#{n}".encode()).hexdigest()
            n += 1
        cat_id = r.category_id if r.category_id in cat_ids else None
        goal_id = r.savings_goal_id if r.savings_goal_id in goal_ids else None
        row_account = currency_account(
            r.account_id if r.account_id in account_ids else f.account_id, r.currency, r.product
        )
        transfer_acc = r.transfer_account_id if r.transfer_account_id in account_ids else None
        if transfer_acc == row_account:
            transfer_acc = None
        # kierunek musi zgadzać się ze znakiem kwoty z wyciągu
        out = r.amount < 0
        if r.type in TRANSFER_TYPES:
            tx_type = TransactionType.transfer_out if out else TransactionType.transfer_in
        elif r.type in SAVING_TYPES and goal_id is not None:
            tx_type = TransactionType.saving_deposit if out else TransactionType.saving_withdrawal
        else:
            tx_type = TransactionType.expense if out else TransactionType.income
        if tx_type in TRANSFER_TYPES:
            cat_id = goal_id = None
        elif tx_type in SAVING_TYPES:
            cat_id = None
        else:
            goal_id = transfer_acc = None
            if cat_id is not None and cat_ids[cat_id].value != tx_type.value:
                cat_id = None
        t_new = Transaction(
                user_id=user.id,
                date=r.date,
                type=tx_type,
                category_id=cat_id,
                savings_goal_id=goal_id,
                description=r.description.strip()[:2000],
                title=r.title,
                counterparty=r.counterparty,
                counterparty_account=(r.counterparty_account or None) and r.counterparty_account[:34],
                note=(r.note or None) and r.note[:2000],
                account_id=row_account,
                transfer_account_id=transfer_acc,
                shop_id=r.shop_id if r.shop_id in shop_ids and tx_type in (TransactionType.expense, TransactionType.income) else None,
                balance_cents=to_cents(r.balance) if r.balance is not None else None,
                source=f.bank,
                import_hash=stored_hash,
                import_batch_id=batch.id,
                refund_of_id=r.refund_of_id if tx_type == TransactionType.income and r.refund_of_id in refund_ok else None,
            )
        if t_new.refund_of_id:
            t_new.category_id = None
        set_amount(t_new, abs(to_cents(r.amount)), r.currency[:8], rates)
        db.add(t_new)
        new_by_hash.setdefault(r.hash, t_new)
        existing.add(stored_hash)
        imported[fi] += 1
    db.flush()
    _link_import_pairs(db, user.id, data.rows, new_by_hash)
    # zwrot do wydatku z tego samego importu
    for r in data.rows:
        t = new_by_hash.get(r.hash)
        if t is None or not r.refund_of_hash or t.type != TransactionType.income or t.refund_of_id:
            continue
        e = new_by_hash.get(r.refund_of_hash)
        if e is not None and e.type == TransactionType.expense:
            t.refund_of_id = e.id
            t.category_id = None
    # --- zapamiętanie reguł „to samo źródło → ta sama kategoria”
    learned = 0
    learned_rules = []
    for lr in data.rules:
        if lr.category_id is not None and lr.category_id not in cat_ids:
            continue
        if lr.savings_goal_id is not None and lr.savings_goal_id not in goal_ids:
            continue
        if lr.category_id is not None and lr.direction.value != "any" and cat_ids[lr.category_id].value != lr.direction.value:
            continue
        target = Target(
            category_id=lr.category_id,
            savings_goal_id=lr.savings_goal_id,
            mark_transfer=lr.mark_transfer,
            transfer_account_id=lr.transfer_account_id if lr.transfer_account_id in account_ids else None,
        )
        rule = upsert_rule(db, user.id, LearnKey(lr.field, lr.pattern.strip()), lr.direction, target)
        if rule:
            if lr.edited:
                # reguła poprawiona w oknie importu (pełny formularz) — staje się Twoją regułą
                seen = {(lr.field.value, lr.pattern.strip().casefold())}
                extras = []
                for x in lr.extra_patterns:
                    k = (x.field.value, x.pattern.casefold())
                    if k not in seen:
                        seen.add(k)
                        extras.append({"pattern": x.pattern, "field": x.field.value})
                rule.extra_patterns = json.dumps(extras, ensure_ascii=False) if extras else None
                rule.exclude_pattern = (lr.exclude_pattern or "").strip() or None
                rule.priority = lr.priority
                rule.shop_id = resolve_shop(db, user.id, lr.shop_id, lr.shop_name)
                rule.mark_recurring = bool(lr.mark_recurring and lr.category_id and cat_ids[lr.category_id].value == "expense")
                rule.auto = False
                db.flush()
                assign_rule_shop(db, user.id, rule)
            learned += 1
            learned_rules.append(rule)

    kept: list[ImportBatch] = []
    for i, b in enumerate(batches):
        b.imported_count = imported[i]
        b.skipped_count = skipped[i]
        if imported[i] or skipped[i]:
            kept.append(b)
        else:  # plik bez wierszy (np. nieczytelny) — nie zostawiamy pustej paczki
            db.delete(b)
    db.flush()
    detect_recurring(db, user.id)
    # reguły z tego importu mogą uzupełnić starsze transakcje bez kategorii — zapytamy o to
    proposals = [p for p in (proposal_for_rule(db, user.id, r) for r in learned_rules) if p["match_count"]]
    db.commit()
    outs = [ImportBatchOut.model_validate(b) for b in kept]
    return ImportCommitOut(
        batches=outs,
        imported_count=sum(imported),
        skipped_count=sum(skipped),
        learned_rules=learned,
        created_accounts=[a.name for a in created_subs],
        proposals=proposals,
        id=outs[0].id if outs else None,
    )


def _link_import_pairs(db, user_id: int, rows: list[ImportRow], new_by_hash: dict[str, Transaction]) -> None:
    """Łączy strony przelewów własnych: dwa nowe wiersze (z dwóch plików) albo nowy wiersz
    z transakcją z wcześniejszego importu — tę ostatnią zamienia na przelew własny."""
    for r in rows:
        t = new_by_hash.get(r.hash)
        if t is None or not is_own_transfer_type(t.type) or t.pair_id is not None:
            continue
        if r.pair_hash:
            other = new_by_hash.get(r.pair_hash)
            if other is not None and other.pair_id is None and is_own_transfer_type(other.type) and other.account_id != t.account_id:
                t.pair_id, other.pair_id = other.id, t.id
                # np. wymiana walut na rachunek utworzony dopiero przy tym imporcie
                if t.type in TRANSFER_TYPES and t.transfer_account_id is None:
                    t.transfer_account_id = other.account_id
                if other.type in TRANSFER_TYPES and other.transfer_account_id is None:
                    other.transfer_account_id = t.account_id
        elif r.pair_tx_id:
            other = db.get(Transaction, r.pair_tx_id)
            if other is None or other.user_id != user_id or other.pair_id is not None or other.account_id in (None, t.account_id):
                continue
            if other.type in (TransactionType.expense, TransactionType.income):
                out = other.type == TransactionType.expense
                target = db.get(BankAccount, t.account_id) if t.account_id else None
                if target is not None and target.savings_goal_id:
                    other.type = TransactionType.saving_deposit if out else TransactionType.saving_withdrawal
                    other.savings_goal_id = target.savings_goal_id
                else:
                    other.type = TransactionType.transfer_out if out else TransactionType.transfer_in
                other.category_id = None
                other.transfer_account_id = t.account_id
            elif other.type in TRANSFER_TYPES and other.transfer_account_id is None:
                other.transfer_account_id = t.account_id
            if t.transfer_account_id is None and t.type in TRANSFER_TYPES:
                t.transfer_account_id = other.account_id
            t.pair_id, other.pair_id = other.id, t.id


@router.get("/batches", response_model=list[ImportBatchOut])
def list_batches(db: DB, user: CurrentUser):
    return db.scalars(
        select(ImportBatch).where(ImportBatch.user_id == user.id).order_by(ImportBatch.created_at.desc())
    ).all()


@router.delete("/batches/{batch_id}", status_code=status.HTTP_204_NO_CONTENT)
def undo_batch(batch_id: int, db: DB, user: CurrentUser):
    """Cofa import: usuwa wszystkie transakcje z danej paczki."""
    b = db.get(ImportBatch, batch_id)
    if not b or b.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono importu")
    ids = list(db.scalars(select(Transaction.id).where(Transaction.import_batch_id == b.id, Transaction.user_id == user.id)))
    unlink_pairs(db, user.id, ids)
    db.execute(delete(Transaction).where(Transaction.import_batch_id == b.id, Transaction.user_id == user.id))
    db.delete(b)
    db.flush()
    detect_recurring(db, user.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
