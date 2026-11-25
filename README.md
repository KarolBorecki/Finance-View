# Finance View — aplikacja do zarządzania finansami osobistymi

Wielu użytkowników, konfigurowalne kategorie, statystyki ze średnimi, import wyciągów CSV
z **PKO BP (iPKO)**, **ING Bank Śląski**, **Credit Agricole**, **Bank Millennium** i **Revolut**
(banki z rachunkami walutowymi, kursy walut przeliczane na złote) i **import ze screenshotów** (odczyt
na urządzeniu), reguły kategorii i sklepów,
które uczą się z Twoich wyborów, zwroty powiązane z wydatkami oraz osobna ewidencja oszczędności. Minimalistyczny czarny interfejs
w stylu liquid glass, działający na komputerze i na telefonie.

- **Backend:** Python 3.13 · FastAPI · SQLAlchemy 2 · SQLite (lub dowolna baza SQLAlchemy) · JWT · zarządzany przez **uv**
- **Frontend:** TypeScript · React 19 · Vite · React Router · Recharts

## iPhone — instalacja w 5 minut

Aplikacja działa na iPhonie jak zwykła aplikacja (ikona na ekranie początkowym, pełny ekran,
działa bez internetu). **Bez serwera** wszystkie dane są zapisywane lokalnie na telefonie
(plik w prywatnym folderze aplikacji + kopia w bazie przeglądarki) i **nie trzeba się logować**.

1. Zbuduj wersję na telefon (potrzebny Node.js 20+):
   ```bash
   cd frontend
   npm install
   npm run build:iphone        # wynik: frontend/dist-iphone/
   ```
   (Gotowy `frontend/dist-iphone/` jest już w projekcie — po zmianach w kodzie zbuduj go ponownie.)
2. Umieść folder `dist-iphone` pod adresem **HTTPS** — najprościej:
   - **Netlify Drop**: wejdź na <https://app.netlify.com/drop> i przeciągnij folder `dist-iphone`
     (darmowe, bez konfiguracji; dostaniesz adres `https://…netlify.app`), albo
   - **GitHub Pages**: skopiuj `deploy/github-pages-iphone.yml` do `.github/workflows/`, wrzuć
     projekt do repozytorium na GitHubie i włącz *Settings → Pages → Source: GitHub Actions* —
     workflow zbuduje i opublikuje aplikację po każdym `git push`.
3. Na iPhonie otwórz ten adres w **Safari** → przycisk **Udostępnij** → **Do ekranu początkowego**.
4. Uruchamiaj aplikację z ikony. Dane zostają na telefonie — nic nie jest wysyłane do internetu.

**Przeniesienie danych z serwera na telefon:** w wersji z serwerem wybierz *Ustawienia → Dane →
Pobierz wszystkie dane*, prześlij plik na iPhone'a (AirDrop / iCloud Drive), a w aplikacji na
telefonie *Ustawienia → Dane → Wczytaj kopię*.

**Kopia zapasowa:** *Ustawienia → Dane → Zapisz kopię* (plik JSON, np. do iCloud Drive). Zrób ją
od czasu do czasu — usunięcie aplikacji z ekranu początkowego kasuje też jej dane.

> Tryb wybiera się sam: jeśli pod tym samym adresem działa backend (`/api/health`), aplikacja
> pracuje z serwerem i wymaga logowania; jeśli nie — działa lokalnie. W wersji z serwerem można
> przejść na tryb lokalny (*Ustawienia → Dane* albo link pod formularzem logowania), a w trybie
> lokalnym wrócić do serwera. Wersja `build:iphone` jest zawsze lokalna.

## iPhone — natywna aplikacja z Xcode

Ta sama wersja „na telefon” (tryb lokalny, bez serwera i logowania) zapakowana jako zwykła
aplikacja iOS ([Capacitor](https://capacitorjs.com), projekt w `frontend/ios/`). Nie potrzebuje
hostingu ani Safari, a dane są dodatkowo kopiowane do pliku widocznego w aplikacji **Pliki**
(*Na moim iPhonie → Finance View → finanse-dane.json*). *Zapisz kopię* otwiera systemowe okno
**Udostępnij** (Zachowaj w Plikach, AirDrop, Mail).

Potrzebne: **Mac z Xcode 16+**, **Node.js 22+** (wymaga go Capacitor), kabel do iPhone'a i Apple ID (wystarczy darmowe).

1. Zbuduj aplikację webową, skopiuj ją do projektu iOS i otwórz Xcode:
   ```bash
   cd frontend
   npm install
   npm run ios              # = npm run build:ios (dist-ios → ios/App/App/public) + otwarcie Xcode
   ```
   Przy pierwszym otwarciu Xcode pobiera pakiety Swift (Capacitor) — chwilę to trwa.
2. W Xcode wybierz projekt **App** → target **App** → **Signing & Capabilities**:
   *Team* = Twoje Apple ID (*Add an Account…*, jeśli go nie ma). Gdy Xcode zgłosi, że identyfikator
   jest zajęty, zmień **Bundle Identifier** (np. `pl.twojeimie.finanse`) — najlepiej też `appId`
   w `frontend/capacitor.config.ts`.
3. Podłącz iPhone'a, wybierz go u góry jako cel i kliknij **▶ Run**.
4. Pierwszy raz na iPhonie: *Ustawienia → Prywatność i ochrona → Tryb dewelopera* → włącz
   (restart telefonu), potem *Ustawienia → Ogólne → VPN i urządzenia → Twoje Apple ID → Ufaj*.

Po zmianach w kodzie: `npm run build:ios` i ponownie **▶ Run** — dane w aplikacji zostają.
Z **darmowym** Apple ID aplikacja działa 7 dni, potem wystarczy ponownie kliknąć **▶ Run**
(dane zostają, o ile nie usuniesz aplikacji). Płatne konto Apple Developer: rok ważności,
TestFlight i instalacja bez kabla.

**Ekran startowy (splash):** grafika jest w `frontend/index.html` (`#splash`). Po jej zmianie `npm run splash`
(wymaga Chrome) odtwarza obrazy dla Xcode (`Splash.imageset`, używane przez `LaunchScreen.storyboard`) i dla
aplikacji z ekranu początkowego (`public/splash/`), więc natywny splash i pierwszy ekran są identyczne. Splash
znika, gdy aplikacja jest gotowa. iOS potrafi pokazywać stary ekran startowy z pamięci — pomaga restart telefonu.

> Gdy Xcode zgłasza *„Brak zbudowanej aplikacji webowej”*, uruchom w `frontend` polecenie
> `npm run build:ios` — folder `ios/App/App/public` jest generowany i nie trafia do repozytorium.

## Docker

Jeden kontener z frontendem i API (FastAPI serwuje zbudowaną aplikację), baza SQLite w wolumenie
`finanse-data`:

```bash
echo "SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" > .env
docker compose up -d --build        # http://localhost:8000 — pierwsze konto zakładasz w aplikacji
```

- **Port**: `PORT=8080` w `.env` (domyślnie 8000). Inne zmienne: `ACCESS_TOKEN_EXPIRE_MINUTES`,
  `DATABASE_URL`, `TZ` (domyślnie `Europe/Warsaw`).
- **Aktualizacja**: `docker compose up -d --build` — brakujące tabele i kolumny dokładają się same,
  dane zostają w wolumenie.
- **Kopia bazy**: `docker compose cp finanse:/data/finanse.db ./finanse-kopia.db`
  (albo *Ustawienia → Dane → Pobierz wszystkie dane* w aplikacji).
- **HTTPS / dostęp z telefonu spoza domu**: wystaw kontener przez reverse proxy (Caddy, Traefik,
  nginx, Cloudflare Tunnel) — uvicorn ufa nagłówkom `X-Forwarded-*`. Z HTTPS aplikację można dodać
  do ekranu początkowego iPhone'a i pracuje wtedy z serwerem.

## Szybki start

Wymagania: [uv](https://docs.astral.sh/uv/) oraz Node.js 20+.

```bash
# 1. Backend (http://127.0.0.1:8000, dokumentacja API: /docs)
cd backend
uv sync
uv run uvicorn app.main:app --reload

# 2. Frontend w trybie deweloperskim (http://localhost:5173, /api przekierowane do backendu)
cd frontend
npm install
npm run dev
```

Opcjonalnie konto demonstracyjne z rokiem przykładowych danych, trzema kontami bankowymi i regułami:

```bash
cd backend && uv run python -m app.seed_demo     # login: demo / demo1234
```

### Tryb „produkcyjny” — jeden proces

```bash
cd frontend && npm run build          # tworzy frontend/dist
cd ../backend && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Jeśli istnieje `frontend/dist`, FastAPI serwuje frontend razem z API pod jednym adresem.

### Konfiguracja (`backend/.env`)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./finanse.db` | np. `postgresql+psycopg://user:pass@host/db` (wymaga `uv add psycopg[binary]`) |
| `SECRET_KEY` | klucz deweloperski | **koniecznie zmień** w produkcji (`python -c "import secrets;print(secrets.token_urlsafe(48))"`) |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `10080` (7 dni) | ważność tokenu logowania |
| `CORS_ORIGINS` | `["http://localhost:5173"]` | dozwolone originy frontendu (JSON) |

Tabele tworzą się automatycznie przy starcie, a do istniejącej bazy z poprzedniej wersji
brakujące kolumny są dokładane automatycznie (`app/migrations.py`) — dane zostają.

## Funkcje

### Interfejs
Trzy zakładki: **Pulpit**, **Statystyki**, **Ustawienia** oraz jeden przycisk **„+”** (na telefonie
na środku dolnego paska), który otwiera okno z trzema kartami: *Ręcznie*, *Z banku* (wyciągi CSV) i *Screenshot*.
Formularz transakcji ma trzy rodzaje: **Wydatek**, **Wpływ** i **Własny** (przelew między Twoimi
rachunkami i celami — wybierasz *Z* i *Na*). Kolejność pól: **kwota**, **opis**, **rachunek**
(zapamiętuje ostatnio użyty), **data** (*Dziś / Wczoraj*), **kategoria** (kafelki, *＋ Nowa
kategoria*), a w zwijanej sekcji **Dodatkowe**: kontrahent, sklep i notatka. Podczas wpisywania
opisu aplikacja **sama proponuje kategorię** (i sklep) — z reguł, a potem z historii, także dla
fragmentu nazwy („bied” → Jedzenie); propozycję widać przy nagłówku *Kategoria* i można ją zmienić.
Jeśli dodawana transakcja wygląda na duplikat, formularz pokazuje podobne i pyta, czy na pewno ją
dodać (*Dodaj mimo to / Nie dodawaj*).

**Niezapisane zmiany są chronione**: okno możesz zamknąć jak chcesz — ✕, kliknięciem obok,
*Esc*, „wstecz” (przycisk przeglądarki, gest) albo na telefonie **przeciągając je palcem w dół**.
Jeśli w formularzu są niezapisane zmiany, aplikacja najpierw pyta *„Zamknąć bez zapisywania?”*
(*Wróć do edycji / Zamknij bez zapisu*); bez zmian okno zamyka się od razu. Tak samo okno importu:
z poprawkami pyta, czy porzucić import. Odświeżenie lub zamknięcie karty przy niezapisanych
zmianach pyta o potwierdzenie.

**Wyszukiwanie fuzzy** wszędzie, gdzie szuka się po nazwie (lista transakcji, transakcje
kategorii, import, wybór zwrotu, ikony): bez wielkości liter, polskich znaków i interpunkcji,
fragment w środku słowa („lando” → Zalando), literówki („biedornka”) i inne końcówki odmiany
(„kotek” → kot).

Wygląd w stylu **liquid glass**: półprzezroczyste, rozmyte panele nad kolorową poświatą,
z jasną krawędzią i miękkim cieniem. Na telefonie okna wysuwają się od dołu, listy zamieniają się
w karty, a nawigacja to pływająca kapsuła na dole ekranu. Domyślny motyw jest czarny.
W *Ustawieniach → Wygląd* wybierasz: motyw (czarny / jasny / systemowy), **kolor motywu**
(13 gotowych albo dowolny własny), **intensywność koloru** (brak / delikatna / wyraźna / mocna /
maksymalna — jak mocno kolor barwi tło, karty, ramki i paski), **tło** (poświata / siatka barw /
zorza / gradient / kropki / kratka / jednolite), **zaokrąglenia** (ostre / zwykłe / okrągłe),
**czcionkę** (systemowa, Inter, Nunito, Manrope, Space Grotesk, Lora, JetBrains Mono — kroje są
w aplikacji, więc działają też offline), **rozmiar tekstu** (mały / zwykły / duży / bardzo duży),
**gęstość** (ciasna / kompaktowa / wygodna / przestronna — tylko odstępy, niezależnie od rozmiaru
tekstu) i **efekt szkła** (wyłączony = lżej dla telefonu). Jest też *Przywróć domyślny wygląd*. Ustawienia zapisują się na koncie (albo na
urządzeniu w trybie lokalnym).

**Ustawienia → Konto**: zmiana nazwy (wyświetlanej w menu), nazwy użytkownika do logowania (z
serwerem), **obrazek profilowy** z 12 wbudowanych (zwierzaki, skarbonka, góry, planeta, fale — albo
inicjał) widoczny w górnym pasku oraz *Wyloguj*. Ikona aplikacji to złota moneta z rosnącym
wykresem na fioletowym tle (PWA, ekran początkowy iPhone'a i aplikacja z Xcode).

### Logowanie
W trybie lokalnym (bez serwera) logowania nie ma — patrz *iPhone* wyżej. Z serwerem:
tylko nazwa użytkownika i hasło, bez e-maila. Ekran startowy to formularz logowania na środku,
z linkiem do założenia konta. Każdy użytkownik widzi wyłącznie swoje dane. Przy aktualizacji
starej bazy dotychczasowy adres e-mail staje się nazwą użytkownika.

### Pulpit
Stały, prosty układ: komunikaty, cztery liczby okresu (wpływy, wydatki, odłożone, pozostało),
a pod nimi **lista transakcji** z filtrami, wyszukiwarką, filtrem *Bez kategorii* i paginacją.
Obok listy (na telefonie pod nią) są: struktura wydatków, wydatki narastająco w bieżącym
miesiącu, budżety (jeśli są ustawione) i cele oszczędnościowe. Wybór okresu i rachunku jest wspólny
dla pulpitu i statystyk. Karta **Rachunki** pokazuje szacowane saldo każdego rachunku i sumę.
Na liście przy transakcji widać sklep (🏪), znacznik **↩ zwrot** (zwrot nie ma etykiety „Bez
kategorii”) i przy wydatku *zwrócono X zł*. Filtr **kategorii pozwala zaznaczyć kilka naraz** (z
wyszukiwarką, plus *Bez kategorii*), a przełącznik **⇄ Ukryj przelewy własne** chowa przelewy między
rachunkami i na cele (wybór jest zapamiętany na urządzeniu).

### Statystyki
- **W czasie**: przełącznik *dzień / tydzień / miesiąc* i trzy widoki:
  - *wydatki i wpływy*, z linią średniej,
  - *narastająco*: suma wydatków i saldo od początku okresu,
  - *według kategorii*: słupki skumulowane,
  - *średnie wg kategorii*: jak skacze średni miesięczny wydatek w każdej kategorii. Średnia
    krocząca z 1 / 3 / 6 / 12 miesięcy (niepełne miesiące są przeliczane na pełny), w złotych albo
    jako % odchylenia od średniej kategorii; wybór kategorii (wszystkie, top 5, pojedyncze) i tabela
    z mapą cieplną miesięcy oraz trendem (ostatnie 3 miesiące wobec średniej). Przełącznik
    **Miesięczne / Tygodniowe** pokazuje to samo w tygodniach (od poniedziałku): średnia krocząca
    z 1 / 4 / 8 / 13 tygodni, zł / tydzień, tabela tygodni i trend z ostatnich 4 tygodni. Przyszła
    część okresu (np. reszta bieżącego miesiąca) nie zaniża średnich.
- **Kategorie**: suma i średnia miesięczna, a na szerszym ekranie także udział, liczba transakcji,
  średnia na transakcję i na tydzień oraz mediana. Kategorię **rozwija się w miejscu**. Pokazuje
  wtedy:
  - liczby z porównaniem do poprzedniego okresu i pasek budżetu,
  - wykres w tygodniach lub miesiącach ze średnią i budżetem,
  - wykres narastający, rozkład na dni tygodnia i rozkład wysokości transakcji,
  - najczęstszych odbiorców i **najczęstsze sklepy** (liczba transakcji i suma; sklep pochodzi
    z reguły albo z ręcznego wyboru),
  - **listę transakcji kategorii** z wyszukiwarką, sortowaniem (data, kwota, nazwa — rosnąco
    i malejąco) i filtrami (rachunek, kwota od–do; pokazuje liczbę i sumę pasujących), linkiem do
    pełnej listy na pulpicie i wyborem kategorii przy każdej transakcji — zmiana przenosi
    transakcję (z możliwością cofnięcia, a aplikacja zaproponuje regułę dla podobnych).
- **Rachunki** (trzecia zakładka obok *Wydatki / Wpływy*): szacowane saldo każdego rachunku i łącznie,
  saldo na początku i końcu okresu, zmiana, wykres salda w czasie (dzień / tydzień / miesiąc,
  z linią „Razem”), wpływy, wydatki, przelewy własne, średnie miesięczne i kategorie
  z największymi wydatkami. Przycisk *Statystyki tego rachunku* filtruje resztę statystyk.
- **Oszczędności** (czwarta zakładka): ile odłożono (łącznie albo dla wybranego celu, z postępem
  do kwoty docelowej), zmiana w okresie, wpłaty i wypłaty, **wykres oszczędności w czasie**
  (skumulowany dla celów), słupki wpłat i wypłat w każdym dniu / tygodniu / miesiącu oraz **lista
  operacji** na celach (kliknięcie otwiera edycję, *⇄ Wpłać* dodaje wpłatę). Liczą się też
  zwykłe przelewy własne na rachunek powiązany z celem (i wypłaty z niego) — patrz niżej.
- **↻ Wydatki stałe** (kafelek pod *Kategoriami* w widoku *Wydatki*): płatności, które powtarzają się
  regularnie do tego samego odbiorcy — patrz *Wydatki stałe* niżej. Na górze: ile kosztują
  **miesięcznie i rocznie**, ile ich jest (aktywne / zakończone), suma w okresie i **udział w
  wydatkach**, a pod spodem wykres miesięcy **stałe vs zmienne**. Lista: nazwa, rytm (*co tydzień /
  co miesiąc / co kwartał / co rok / co N dni*), kiedy **następna płatność** (albo że się spóźnia),
  typowa kwota i równowartość miesięczna. Rozwinięcie pokazuje szczegóły (od kiedy, ile płatności,
  zmiana kwoty od pierwszej, po czym rozpoznany), zmianę nazwy, *Edytuj regułę* albo *＋ Utwórz
  regułę*, listę płatności z *odepnij* i *To nie jest wydatek stały*. Odrzucone można przywrócić; *⚙ Czułość wykrywania* ustawia
  tolerancję odstępu i kwoty.
- **🏪 Sklepy** (kafelek pod *Wydatkami stałymi*): zestawienie sklepów z okresu —
  ile razy i za ile kupujesz, **jak często** (*co N dni*), średni zakup i udział w wydatkach.
  Na górze podsumowanie: liczba sklepów (i nowych w okresie), najczęściej odwiedzany, najdroższe
  średnie zakupy i zmiana wydatków w sklepach względem poprzedniego okresu tej samej długości.
  Przy sklepie: znacznik **nowy** (pierwszy zakup w tym okresie), **trend** ▲/▼ względem
  poprzedniego okresu i kiedy ostatnio. Sortowanie: *Najczęściej / Najwięcej / Średnio / Ostatnio
  / Wzrost*. Pasek pod nazwą ma długość wg sortowania i kolory kategorii. Kliknięcie sklepu
  rozwija szczegóły: najmniejszy, mediana i największy zakup, zakupy w miesiącu, poprzedni okres,
  od kiedy tam kupujesz, **dni tygodnia** i **miesiące** (wykresiki) oraz **rozbicie na kategorie**
  z udziałem sklepu w każdej z nich („62% kat.” = tyle wydatków na tę kategorię robisz w tym
  sklepie). Nagłówek mówi, jaka część wydatków ma przypisany sklep. Kwoty są po zwrotach.
- Podpowiedź z wartością po najechaniu na wykres ma prawie nieprzezroczyste tło, więc jest czytelna.

> **Zwroty nie są wpływami**: pomniejszają swój wydatek (całkowicie zwrócony wydatek znika ze
> statystyk). Gdy wydatek jest poza wybranym okresem, zwrot liczy się jako ujemny wydatek w jego
> kategorii w dniu zwrotu.

> Średnia miesięczna = suma ÷ (liczba dni okresu ÷ 30,44), więc niepełne miesiące na krańcach
> zakresu nie zaburzają wyniku.

### Wydatki stałe
Aplikacja sama wykrywa **wydatki stałe** (abonamenty, rachunki, czynsz, raty) — po każdym imporcie
i zmianie transakcji, także w trybie lokalnym. Seria to **co najmniej 3 wydatki**:
- na **ten sam rachunek zewnętrzny** (numer rachunku kontrahenta z wyciągu), a gdy wyciąg go nie
  podaje (np. płatności kartą) — do tego samego odbiorcy (kontrahent albo początek opisu, jak w regułach),
- z **podobną kwotą** (domyślnie ±15%) i w tej samej walucie,
- w **regularnych odstępach** (domyślnie ±20%) od **tygodnia do roku**: co tydzień, co 2 tygodnie,
  co miesiąc, co 2 miesiące, co kwartał, co pół roku, co rok albo „co N dni”; jeden brakujący
  miesiąc w wyciągach nie przerywa serii,
- przy czym odbiorca nie dostaje w tym czasie wielu innych płatności — dzięki temu zwykłe zakupy
  w sklepie, w którym bywasz co kilka dni, nie stają się „wydatkiem stałym”. Dwa abonamenty u tego
  samego odbiorcy z różnymi kwotami to dwa osobne wydatki stałe.

**Raz wykryty wydatek stały zostaje** — znika tylko wtedy, gdy uznasz go za zwykły wydatek
(*To nie jest wydatek stały*). Zmiana tolerancji, usunięcie części płatności ani nieregularna
kolejna płatność go nie usuwają; przy braku nowych płatności trafia do *Zakończonych*.

Kolejne płatności **wykrytej serii** (ten sam odbiorca i waluta, kwota w granicach tolerancji od
ostatniej płatności — podwyżki cen są śledzone) dołączają do niej same, także przy imporcie
i niezależnie od dnia płatności.

**Wydatek stały z reguły**: w zwykłej regule kategoryzacji (*Ustawienia → Reguły*, okno reguły
w imporcie) jest opcja **↻ Oznacz jako wydatek stały** — dostępna, gdy reguła przypisuje kategorię
wydatków. Wszystkie wydatki pasujące do takiej reguły (wcześniejsze i z przyszłych importów, z
wszystkimi jej wzorcami i wyjątkami) tworzą jeden wydatek stały (znacznik *reguła*). Najszybciej:
w oknie zapisanego wydatku **↻ Oznacz jako wydatek stały** otwiera formularz reguły wypełniony jego
odbiorcą (numer rachunku albo kontrahent) i kategorią, z zaznaczoną opcją. Wykryty automatycznie
wydatek stały zamienisz w regułę przyciskiem *＋ Utwórz regułę* w Statystykach — reguła go przejmuje
(nazwa i odpięte płatności zostają). Reguły z tą opcją mają na liście znacznik *↻ stały* i filtr
*↻ Wydatki stałe*. *To nie jest wydatek stały* przy wydatku z reguły wyłącza opcję w regule
(kategorię dalej przypisuje); usunięcie reguły usuwa jej wydatek stały. W oknie wydatku *Odepnij*
robi z płatności zwykły wydatek.

Transakcje wydatków stałych są oznaczone na listach znacznikiem **↻ stała**, a wydatki stałe są w
Statystykach (patrz wyżej). Wydatek stały jest *aktywny*, dopóki kolejna płatność nie spóźnia się
więcej niż o pół okresu. Odrzucone wydatki stałe i odpięte transakcje są zapamiętane — wykrywanie
ich nie przywraca. Tolerancje zmienisz w *Statystyki → Wydatki stałe → ⚙ Czułość wykrywania*
(dotyczą nowych serii i przypisywania kolejnych płatności). Przy aktualizacji istniejącej bazy
wydatki stałe są wykrywane od razu w całej historii.

### Import i automatyczne uczenie się kategorii
1. **+ → Z banku**: wybierz jeden lub kilka plików CSV. Bank i konto zwykle rozpoznają się
   same.
2. Otwiera się okno **Sprawdź import** — od razu z filtrem **Bez kategorii** (to trzeba uzupełnić;
   uzupełnione pozycje zostają widoczne do zmiany filtra). Każdemu wpisowi możesz osobno ustawić
   kategorię (także **＋ Nowa kategoria…** prosto z listy), poprawić opis, dodać notatkę, pominąć go
   lub usunąć. Filtry: *Wszystkie / Bez kategorii / Duplikaty / Przelewy i oszczędności*. Operacje
   masowe działają na widocznych pozycjach. Przelewy własne na liście kategorii są pogrupowane
   według banków (*⇄ Przelew własny → 🏦 Revolut*). Panel reguł przewija się sam, gdy reguł jest dużo.
3. **Uczenie na żywo**: gdy wybierzesz kategorię dla wpisu, ta sama kategoria trafia od razu do
   pozostałych wpisów z **tego samego źródła** (np. wszystkie „BIEDRONKA …”), z możliwością
   cofnięcia. Panel **„Zapamiętam na przyszłość”** uzupełnia się sam regułami, np.
   `kontrahent BIEDRONKA* → Jedzenie`. Każdą można odznaczyć, poprawić wzorzec albo **✎ Edytować**
   w pełnym formularzu reguły (kilka wzorców, wyjątek, sklep, kierunek, priorytet, inna kategoria —
   wtedy pozycje z tego źródła od razu dostają nową kategorię). Poprawiona reguła ma znacznik
   *poprawiona* (z *↺ Cofnij poprawki*) i zapisze się przy zatwierdzeniu jako Twoja reguła.
4. **Reguła w trakcie importu**: *＋ Reguła* (obok wyszukiwarki) albo **⚙** przy wpisie otwiera
   pełny formularz reguły (z wieloma wzorcami, sklepem, kierunkiem), przy ⚙ wypełniony danymi wpisu.
   Po zapisaniu reguła od razu trafia do *Ustawienia → Reguły* i **aktualizuje pasujące pozycje tego
   importu** (z możliwością *Cofnij w imporcie*). Nie zmienia sparowanych przelewów własnych,
   wymian/doładowań Revolut ani zwrotów. Takie reguły widać w panelu „Zapamiętam na przyszłość”
   w sekcji **Dodane w tym imporcie** — z *✎ Edytuj* (zmiany od razu trafiają do importu) i *Usuń*.
5. Po zatwierdzeniu reguły trafiają do *Ustawienia → Reguły* jako **zapamiętane**. Przy kolejnym
   imporcie podobne transakcje dostają kategorię automatycznie (z dopiskiem „zapamiętane”).

**Uczenie przy edycji, z pytaniem i wyjątkami.** Gdy na liście przypiszesz kategorię transakcji
z wyciągu:
- **jeśli żadna reguła jej nie obejmuje**, aplikacja zapamiętuje regułę dla tego źródła (np.
  `kontrahent ŻABKA* → Jedzenie`) i szuka w bazie podobnych transakcji bez kategorii. Jeśli jakieś
  znajdzie, **pyta**, pokazując regułę i listę tych transakcji. Odznaczone pozycje stają się
  **wyjątkami**, których reguła nigdy nie zmieni. Do wyboru są: *Uzupełnij zaznaczone*,
  *Tylko zapamiętaj* albo *Nie twórz reguły*. Gdy nic nie pasuje, pojawia się tylko komunikat
  z przyciskiem *Cofnij*.
- **jeśli obejmuje ją reguła z inną kategorią**, aplikacja pyta, czy to *wyjątek — tylko ta
  transakcja*, czy *zmienić regułę* na nową kategorię.

Po imporcie, jeśli nowo zapamiętane reguły pasują do starszych transakcji bez kategorii, pojawia
się to samo pytanie z listą i wyjątkami.

**Propozycje nowych reguł** (*Ustawienia → Reguły*): źródła, którym co najmniej dwa razy nadałeś
tę samą kategorię, a które nie mają jeszcze reguły. Przy każdej widać, ile transakcji bez
kategorii uzupełni. *Dodaj* tworzy regułę i otwiera pytanie o uzupełnienie, *✕* ukrywa propozycję.

**Wyjątki w regułach**: poza wyjątkami dla pojedynczych transakcji każda reguła może mieć wzorzec
wyjątku, np. `BIEDRONKA*` oprócz `*WARSZAWA*`. Liczbę wyjątków widać na liście reguł, a w edycji
reguły można je wyczyścić.

Źródło to kontrahent, nadawca wpływu lub nazwa sklepu (a gdy go brak, początek opisu). Numery
sklepów, kart i daty są odcinane, więc „BIEDRONKA 4321 KRAKOW” i „BIEDRONKA 0815 WARSZAWA”
dają jedną regułę `BIEDRONKA*`. Twoje ręczne reguły mają pierwszeństwo i uczenie ich nie
nadpisuje. Poprawka kategorii aktualizuje zapamiętaną regułę zamiast tworzyć nową.

**Reguły ręczne**: pole *tytuł / kontrahent (źródło wpływu) / numer rachunku / cały opis*
(domyślnie *Cały opis*), wzorzec z `*` (dowolny tekst) i `?` (jeden znak), na przykład
`WYPŁATA ZA OKRES *` w polu *Tytuł*. **Jedna reguła może mieć kilka wzorców** (*＋ Kolejny wzorzec*),
każdy z własnym polem — np. `biedronka` w całym opisie i `JMP S.A.` w kontrahencie → Jedzenie, sklep
Biedronka. Reguła działa, gdy pasuje którykolwiek wzorzec; na liście widać „+N wzorce”. Numer
rachunku porównywany jest po samych cyfrach po obu stronach (apostrofy, spacje, „PL” nie
przeszkadzają).
Do tego kierunek (wpływy lub wydatki) i akcja: kategoria, cel oszczędnościowy albo przelew własny.
Przed dopasowaniem tekst i wzorzec są **normalizowane**: małe litery, bez polskich znaków, bez spacji
i znaków specjalnych — `allegro.pl` pasuje do „ALLEGRO PL SP. Z O.O.”, a `ŻABKA` do „zabka-z12”.
Edytor na bieżąco pokazuje pasujące transakcje.

**Grupy podobnych reguł**: lista reguł grupuje wzorce według procentowego podobieństwa (domyślnie
≥ 60%, do wyboru 50–90% albo bez grupowania), np. `BIEDRONKA*`, `*BIEDRONKA 1234*` i
`Biedronka sklep` w jednej grupie. Przy każdej regule widać podobieństwo do pierwszej w grupie,
a znacznik *różne kategorie* pokazuje grupy, w których podobne wzorce przypisują różne kategorie.

**Filtrowanie reguł** (*Ustawienia → Reguły*): wyszukiwarka (wzorce, wyjątki, kategoria, sklep),
filtr kategorii / celu / przelewu własnego, pola wzorca, kierunku, sklepu (*ze sklepem / bez
sklepu* / konkretny) i *Z wyjątkami*, obok *Wszystkie / Zapamiętane / Moje* — z licznikiem
„Pasuje X z Y” i *Wyczyść filtry*.

**Sklepy**: karta 🏪 Sklepy jest w *Ustawienia → Kategorie* (pod listą kategorii). Regułę można (opcjonalnie) przypisać do sklepu — wybierz go z listy zdefiniowanych
sklepów albo *＋ Nowy sklep…*; *reguła bez sklepu* zostawia ją bez sklepu. Pasujące wydatki i wpływy (także już zapisane
i importowane w przyszłości) dostają ten sklep. Listą sklepów zarządzasz w karcie **🏪 Sklepy**
(*Ustawienia → Kategorie*): dodawanie, zmiana nazwy, usuwanie (transakcje i reguły zostają, tylko bez
sklepu). Kliknięcie ikonki przy sklepie otwiera okno, w którym nadasz mu **kolor (z palety, dowolny z próbnika
albo kod #RRGGBB) i emoji** —
widać je na liście transakcji, w listach wyboru sklepu, w regułach i w statystykach. Przy ręcznym dodawaniu wydatku lub wpływu sklep wybierasz z listy zdefiniowanych sklepów;
wybór podpowiada kategorię z reguł tego sklepu.

### Import ze screenshotów
**+ → Screenshot**: wybierz jeden lub kilka obrazów (maks. 12): historię operacji z aplikacji banku, szczegóły
płatności, potwierdzenie, powiadomienie albo paragon. Aplikacja odczyta **datę, kwotę (z walutą i znakiem)
i tytuł** każdej operacji — jeden screenshot może mieć ich wiele.

1. **Sprawdzenie odczytu** — lista obok miniatury. Pola, których nie udało się odczytać na pewno (np. brak daty na
   obrazie, kwota bez znaku), są wyróżnione; wszystko można poprawić, usunąć albo dopisać.
2. **Dalej** otwiera zwykłe okno **Sprawdź import**: reguły kategorii, sklepów i wydatków stałych, podpowiedzi
   z historii, przelewy własne i duplikaty działają tak samo jak przy wyciągu CSV. Operacja widoczna na dwóch
   zrzutach albo już zaimportowana z banku (ta sama kwota, dzień i rachunek) jest oznaczana jako duplikat.

Daty „Dziś”, „Wczoraj” i „16 lis” (bez roku) liczą się od dnia zrobienia screenshota (z nazwy lub daty pliku). Gdy
kwota jest w dwóch walutach, brana jest ta w złotych. Salda i „dostępne środki” są pomijane.

Odczyt (Tesseract z polskim modelem językowym) działa **na urządzeniu** — obraz nie jest wysyłany do internetu ani na
serwer. W aplikacji z Xcode moduł odczytu jest w środku; wersja z ekranu początkowego pobiera go (ok. 7 MB) z adresu
aplikacji przy pierwszym użyciu, potem działa offline. Kod: `frontend/src/ocr/`.

### Zwroty
Wpływ można oznaczyć jako **zwrot za wcześniejszy wydatek** (formularz transakcji, rodzaj
*Wpływ*). Po wpisaniu kwoty aplikacja szuka w bazie wydatków z ostatniego roku, **wcześniejszych
niż zwrot**, z **tą samą albo podobną kwotą (±25%)**, które nie zostały jeszcze zwrócone w całości.
Najwyżej są: ta sama kwota, wspólne słowa w opisie i kontrahencie, ten sam rachunek, bliższa data.
Gdy jest wydatek z identyczną kwotą, formularz od razu pyta *„Czy to zwrot za …?”*. Przycisk
*↩ To zwrot za wydatek…* otwiera listę kandydatów z wyszukiwarką (po opisie, dowolna kwota).
Zwrot dostaje kategorię wydatku, a w statystykach pomniejsza wydatek zamiast liczyć się jako
wpływ; to samo w sumach listy transakcji. Jeden wydatek może mieć kilka zwrotów częściowych.
Usunięcie wydatku zostawia zwrot jako zwykły wpływ. Przy imporcie z Revoluta operacje **Card
refund** są same wiązane z pasującym wydatkiem (z bazy albo z tego samego pliku: wspólne słowo w
opisie, np. nazwa sklepu, albo ta sama kwota w ciągu 30 dni) — w oknie importu widać „↩ zwrot do: …”
z przyciskiem *odepnij*.

### Duplikaty
**Przy imporcie CSV** każda pozycja jest porównywana z bazą i z pozostałymi plikami tego samego
importu:
- **duplikat** — ta sama kwota, **ten sam dzień i ten sam rachunek**. Domyślnie pomijany, ale
  w oknie weryfikacji (pole wyboru przy wierszu) i w oknie zatwierdzenia (*Dodaj / Pomiń*) możesz
  go **dodać mimo to** — nawet jeśli to identyczny wiersz wyciągu;
- **podobna** — ta sama kwota i kierunek, ale inny dzień (±3 dni przy podobnym opisie albo
  ±1 dzień), inny lub nieprzypisany rachunek, albo wspólne słowo (dłuższe niż 3 litery) czy ta sama
  kategoria w ciągu 2 tygodni. Jest oznaczona i widać, z czym ją dopasowano, ale **domyślnie
  zostaje dodana** — pominąć ją możesz przy zatwierdzaniu.

Operacje z różnych rachunków nie są duplikatami. **Przy ręcznym dodawaniu** transakcji działa
ostrzeżenie jak dotąd: (ta sama kwota i wspólne słowo > 3 litery w ciągu 2 tygodni) albo (ta sama
kwota i data) albo (ta sama kwota i kategoria w ciągu 2 tygodni) — aplikacja pyta, czy na pewno
dodać.

### Rachunki, banki, przelewy własne i oszczędności
- **Rachunki** (*Ustawienia → Rachunki*): bank, nazwa, waluta, **dowolnie wiele numerów**
  — rachunków (NRB/IBAN) i końcówek kart (4 cyfry) — oraz **telefonów BLIK**. Po numerach aplikacja
  rozpoznaje rachunek wyciągu (ING, CA, Millennium) i **przelewy między Twoimi rachunkami**, które
  nie są liczone jako wydatki ani wpływy: przelew na rachunek z listy, „przelew na kartę” (np. Visa
  Direct do Revolut**1234) na kartę z listy, BLIK na telefon przypisany do innego rachunku. **Ten sam
  numer może mieć kilka rachunków w różnych walutach** (np. Revolut PLN i Revolut EUR z jednym IBAN-em)
  — operacje i przelewy rozdzielamy wtedy po walucie; w tej samej walucie numer (i każdy telefon)
  należy tylko do jednego rachunku. Przelewy własne rozpoznaje też typ operacji
  („PRZELEW WŁASNY”, doładowanie i wymiana walut w Revolut) oraz reguły. Przycisk **Wykryj przelewy
  w historii** oznacza takie przelewy wśród zapisanych transakcji i **łączy strony przelewów**, które
  już są w bazie — np. *Topup* w Revolut z wydatkiem „REVOLUT**1234” w PKO (ta sama kwota, ±4 dni;
  co najmniej jedna strona musi już być przelewem własnym).
- **Kategorie** (*Ustawienia → Kategorie*): wyszukiwarka, sortowanie (nazwa / liczba transakcji /
  budżet) i filtry *Wszystkie / Używane / Nieużywane / Z budżetem*.
- **Rachunek i bank**: **każdy rachunek należy do banku** (wybierasz go z listy albo zakładasz
  *＋ Nowy bank…* w tym samym oknie). **Bank to grupa rachunków z formatem wyciągu** (np. Revolut →
  Revolut PLN, Revolut EUR, Revolut USD) — rachunek bierze format z banku. Bank nie ma własnych
  operacji, numerów kart ani telefonów, a jego saldo to suma jego rachunków w złotych. Na listach
  wyboru bank jest grupą (🏦) z rachunkami w środku. Rachunki sprzed tej zmiany trafiły same do
  banku swojego formatu (np. „PKO BP”); bank z rachunkami nie da się usunąć. Saldo wpisane ręcznie
  podajesz **w walucie rachunku** (pole pokazuje walutę, np. EUR).
- **Przelew własny w obie strony**: przelew zapisany po jednej stronie (np. z wyciągu rachunku A na
  rachunek B, bez wyciągu B) widać też po wybraniu rachunku B na liście, a saldo B uwzględnia go jako
  wpływ. Gdy wgrasz wyciąg B, obie strony łączą się w parę i nic nie liczy się podwójnie.
- **Rachunki walutowe w banku**: walutę wybierasz z listy walut zdefiniowanych w *Ustawienia →
  Waluty*; dla skarbonki Revoluta dodaj produkt „Savings”. Import wyciągu na bank **sam rozdziela
  operacje** według kolumn `Currency` i `Product`. Jeśli rachunku w danej walucie brakuje, okno
  importu to pokazuje („→ nowy rachunek USD”), a rachunek powstaje przy zatwierdzeniu. Wyciąg
  wielowalutowy wgrany na samodzielny rachunek zamienia go w bank z rachunkami. Wyciąg bez numeru
  rachunku (Revolut) trafia automatycznie na jedyny bank tego formatu. Wymiana walut między
  rachunkami jest parowana jako przelew własny (kwoty porównywane po przeliczeniu na złote).
- **Kursy walut** (*Ustawienia → Waluty*): globalnie ustawiasz, ile złotych kosztuje 1 EUR, USD itd.
  Na start są EUR, USD, GBP i CHF z kursami średnimi NBP z połowy listopada 2026 (zmień je na
  bieżące). Tylko waluty z tej listy (i PLN) są do wyboru przy rachunkach i transakcjach.
  Każda transakcja pamięta kwotę w swojej walucie, a **wszystkie sumy, statystyki, budżety
  i salda w złotych są liczone według aktualnie ustawionych kursów** — zmiana kursu od razu
  przelicza wszystko. Na listach widać kwotę oryginalną i „≈ zł”; salda rachunków walutowych
  pokazujemy w ich walucie i w złotych. Waluty bez kursu są liczone 1:1 (aplikacja o tym
  ostrzega). W formularzu kwotę wpisujesz w walucie wybranego rachunku; przelew własny między
  rachunkami w różnych walutach ma pole *Wpłynęło na rachunek docelowy* (puste = wg kursu).
- Rachunek powiązany z celem oszczędnościowym: przelew na nie zapisuje się jako wpłata na cel.
  Także **zwykły przelew własny na taki rachunek** (np. z konta osobistego na konto oszczędnościowe
  przypisane do celu „Wakacje”) liczy się jako wpływ na ten cel, a przelew z niego — jako wypłata.
  Działa to od razu dla już zapisanych przelewów (bez zmiany danych); przelew w parze liczy się
  raz, a przelewy między dwoma rachunkami tego samego celu nie zmieniają jego stanu.
  Na pulpicie i w statystykach takie przelewy liczą się jako *Odłożone na oszczędności* (a nie
  jako pominięte przelewy własne).
- **Przelew własny** (rodzaj *Własny* w formularzu, przyciski *⇄ Przelew* na pulpicie): z dowolnego
  rachunku lub celu na dowolny rachunek lub cel. **Cele oszczędnościowe działają jak rachunki
  oszczędnościowe.** Przelew między dwoma rachunkami (albo dwoma celami) zapisuje się jako dwie
  połączone transakcje — wypływ z jednego i wpływ na drugie — więc salda obu się zgadzają,
  a przelew nie jest wydatkiem ani wpływem. Na liście widać kierunek („PKO → Revolut ✓”, ✓ = obie
  strony zapisane). Edycja kwoty lub daty jednej strony zmienia drugą; usunięcie ręcznego przelewu
  usuwa obie strony.
- **Przelewy własne w imporcie**: wypływ z rachunku A i wpływ na rachunek B o tej samej kwocie (±4 dni)
  są parowane i oznaczane jako przelew własny — gdy wgrywasz oba wyciągi naraz, a także gdy
  wyciąg z drugiego rachunku wgrasz później (wcześniej zapisany „wydatek” zamieni się wtedy
  w przelew). Do sparowania potrzebna jest przesłanka: numer rachunku, słowo „przelew”,
  „doładowanie”, „top-up”, nazwa drugiego rachunku itp.; zwykłe zakupy o tej samej kwocie nie są
  łączone. W statystykach rachunków cele mają własne karty i linię na wykresie salda.
- **Saldo rachunku** jest liczone z kolumny „saldo po transakcji” w importowanych CSV: stan na koniec
  ostatniego dnia z wyciągu plus późniejsze operacje (np. wpisane ręcznie). Między wyciągami
  i przed nimi saldo jest odtwarzane z transakcji, więc powstaje pełna historia salda. Jeśli
  wyciąg nie ma salda albo wynik się nie zgadza, wpisz saldo ręcznie w ustawieniach rachunku
  („stan na koniec dnia”) — nowsze wyciągi i tak mają pierwszeństwo. Ponowny import starego
  wyciągu uzupełnia saldo w transakcjach zaimportowanych przed tą funkcją.
- **Import**: przy wyborze pliku wskazujesz rachunek, z którego pochodzi wyciąg (albo tworzysz nowy
  opcją *＋ Nowy rachunek…*); przy kilku plikach rachunek każdego zmienisz w oknie weryfikacji, gdzie
  widać też saldo po ostatniej operacji z pliku.
- **Oszczędności** (*Ustawienia → Oszczędności*): cele z kwotą i terminem, postęp, kwota do
  odkładania miesięcznie oraz przyciski *Odłóż / Wypłać*. Wpłaty nie są wydatkami.
  W edycji celu można wpisać **stan celu na dzień** (jak saldo rachunku): kwota nadpisuje
  wszystkie wcześniejsze wpłaty i wypłaty, a stan celu = ta kwota + operacje po tym dniu. Karta
  celu pokazuje „od stanu z …”, wykres liczy wcześniejsze miesiące wstecz od tego stanu, a na
  liście operacji w statystykach wcześniejsze są wyszarzone („nadpisane stanem”). Wyczyszczenie
  pola przywraca liczenie z samych operacji.
- **Importy** (*Ustawienia → Importy*): historia z możliwością cofnięcia każdego pliku.
- **Dane** (*Ustawienia → Dane*): tryb pracy, kopia zapasowa i jej wczytanie, eksport danych
  z serwera do trybu lokalnego.
- **Ikony kategorii i sklepów**: ok. 550 emoji w 13 grupach (jedzenie, dom i rachunki, transport,
  technologia, zwierzęta — ponad 120, zdrowie…),
  z wyszukiwarką po polsku („kot”, „paliwo”) i polem na dowolne własne emoji.

## Obsługiwane formaty CSV

Parsery szukają wiersza nagłówka po nazwach kolumn (nie po pozycjach), same rozpoznają
separator (`;`, `,`, tab) i kodowanie (UTF-8 / Windows-1250), akceptują kwoty `-1 234,56`,
`-1234.56`, `+1500.00` i daty `RRRR-MM-DD`, `DD.MM.RRRR`, `DD-MM-RRRR`.

| Bank | Kluczowe kolumny | Uwagi |
|---|---|---|
| PKO BP (iPKO) | `Data operacji, Data waluty, Typ transakcji, Kwota, Waluta, Saldo po transakcji, Opis transakcji` + kolumny bez nazwy | Data transakcji = **Data waluty** (gdy pusta — Data operacji); szczegóły z dodatkowych kolumn są łączone; numery kart/rachunków odfiltrowane, zostaje kontrahent / miejsce i tytuł |
| ING Bank Śląski | `Data transakcji, Dane kontrahenta, Tytuł, Nr rachunku, Kwota transakcji (waluta rachunku), Saldo po transakcji` | Data = **Data transakcji**; `Nr rachunku` (rachunek drugiej strony, w pliku w apostrofach) porównywany po samych cyfrach z numerami Twoich rachunków → przelew własny. Pomijane: wiersze nagłówkowe z danymi rachunku, stopka, niezaksięgowane blokady kartowe |
| Credit Agricole | Eksport CA24 (ok. 100 kolumn): `Z rachunku, Kategoria transakcji, Nadawca, Rachunek nadawcy, Odbiorca, Rachunek odbiorcy, Tytuł, Numer telefonu, Numer karty, Miejsce transakcji, …, Data operacji, Data księgowania, Kwota, …, Saldo po operacji, Opis`; także starszy, krótki format (`Data operacji`, `Kwota` lub `Obciążenia`/`Uznania`, `Opis operacji`) | Data = **Data operacji**; powtarzające się nazwy kolumn (`Kwota`, `Adres`, `Okres`) obsłużone; kwoty z dopiskiem „PLN”; konto wyciągu z `Z rachunku`, telefon BLIK z `Numer telefonu` |
| Bank Millennium | `Numer rachunku/karty, Data transakcji, Data rozliczenia, Rodzaj transakcji, Na konto/Z konta, Odbiorca/Zleceniodawca, Opis, Obciążenia, Uznania, Saldo, Waluta` | Data = **Data transakcji**; z opisu płatności kartą usuwany jest dopisek kraju i daty („…WARSZAWA POL 2024-05-12”) |
| Revolut | `Type, Product, Started Date, Completed Date, Description, Amount, Fee, Currency, State, Balance` (lub polskie: `Typ, Produkt, Data rozpoczęcia, …, Stan, Saldo`) | Tylko operacje zakończone; kwota = Amount − Fee; data = **Started Date**. O charakterze operacji decyduje kolumna **Type** (ważniejsza niż reguły): *Exchange* → przelew własny na rachunek Revolut w walucie z opisu („Exchanged to EUR”) i para z drugą stroną wymiany; *Topup* → przelew własny łączony z pasującym wydatkiem z innego banku (ta sama kwota, ±4 dni); *Card refund* → zwrot powiązany z wydatkiem; *Transfer*, *Card Payment* i inne → zwykłe operacje kategoryzowane regułami. Operacje w skarbonkach (produkt Savings) pomijane |

Pliki zapisane bez polskich liter (zamiast „ł”, „ą” widać „?” albo „�”, np. „P?atno?? kart?”)
też się importują: nagłówki są dopasowywane z tolerancją, a w znanych słowach z wyciągów polskie
litery są odtwarzane („Płatność kartą”).

Z każdego wiersza zapisywane są osobno: **tytuł**, **kontrahent** (nadawca/odbiorca/miejsce
płatności kartą) i **numer rachunku kontrahenta** — na nich działają reguły i wykrywanie
przelewów własnych.

Przykładowe pliki są w katalogu `samples/`. Na koncie demo (`demo` / `demo1234`) wgraj razem
`ipko_przelew_wlasny.csv` i `ipko_przelew_wlasny_cz2.csv` na konto „PKO osobiste”. Zobaczysz
reguły, przelewy własne, transakcje już zapisane w bazie i duplikaty między nakładającymi się
plikami. `revolut_przyklad.csv` pokazuje import z Revoluta i zapamiętane reguły,
`revolut_eur_pln.csv` — wyciąg z dwiema walutami rozdzielany na rachunki walutowe banku, a
`credit_agricole_ca24.csv` i `millennium_przyklad.csv` — formaty tych banków.

## Testy

```bash
cd backend && uv run pytest
```

Tryb lokalny to port logiki backendu do TypeScriptu (`frontend/src/local/`): te same parsery,
reguły, uczenie, duplikaty, statystyki i salda. Jego zgodność z backendem była sprawdzana tak,
że ten sam scenariusz (import kilku plików, reguły, edycje, statystyki, salda, cofnięcie importu)
uruchamiano na obu i porównywano odpowiedzi API.

Testy obejmują wyszukiwanie fuzzy, normalizację tekstu w regułach, podpowiedź kategorii, rachunki
zawsze w banku (z migracją), ten sam numer w kilku walutach, przelew własny w obie strony,
stan celu na dzień, rozszerzone statystyki sklepów, średnie tygodniowe kategorii, statystyki oszczędności, zwroty (kandydaci, powiązanie, netowanie w statystykach i sumach) i sklepy
(z reguł, przy imporcie, ręcznie, „Najczęstsze sklepy”, kolor i emoji, zestawienie sklepów), przelewy na rachunek celu jako oszczędności, przelewy własne (rachunki i cele, edycja i usuwanie obu stron, parowanie przy imporcie
dwóch plików i z wcześniejszym wyciągiem), reguły podobnych transakcji, parsery wszystkich banków, izolację użytkowników, walidację kategorii,
rozdzielenie oszczędności od wydatków, obliczenia średnich, import z deduplikacją i cofaniem,
konta i wykrywanie przelewów własnych, daty z właściwych kolumn i numery w apostrofach, Revolut wg kolumny Type (wymiana, doładowanie, zwrot), łączenie przelewów w historii, reguły z wieloma wzorcami, wzorce reguł z `*`/`?` na różnych polach,
duplikaty (nakładające się wyciągi, wiele plików naraz, transakcje wpisane ręcznie, przesunięte
daty, dopasowanie 1:1), zapis poprawek z okna weryfikacji, ustawienia użytkownika,
podpowiedzi z historii, uczenie reguł (klucze źródła, import, propozycje po edycji z wyjątkami,
konflikt z regułą, wzorce wyjątków, propozycje nowych reguł, pierwszeństwo reguł ręcznych),
szeregi czasowe dzień/tydzień/miesiąc i szczegóły kategorii, wydatki stałe (rytmy od tygodnia do
roku, brakujące płatności, rozdzielanie po kwocie, zakupy w sklepie to nie seria, statystyki,
zmiana nazwy, odpinanie, odrzucanie i tolerancje, trwałość wykrytych, reguła dla kolejnych płatności,
reguły z opcją „wydatek stały”, przejęcie wykrytego przez regułę), zmiana danych konta, poprawione reguły z importu, parser Revoluta (wersja angielska i polska), logowanie bez e-maila oraz migracje
istniejącej bazy.

## Struktura

```
backend/
  app/
    main.py            # aplikacja FastAPI (+ serwowanie zbudowanego frontendu)
    models.py          # User, BankAccount, Category, Transaction, SavingsGoal, CategoryRule, Shop, ImportBatch, RecurringExpense
    migrations.py      # automatyczne dokładanie kolumn i zmiany nazw (aktualizacja starej bazy)
    routers/           # auth, settings, accounts, categories, transactions (z kandydatami zwrotów), savings, rules, shops,
                       # imports, recurring (wydatki stałe), stats, export, currencies
    importers/         # base.py + ipko.py, ing.py, credit_agricole.py, millennium.py, revolut.py
    services/          # stats.py, categorize.py (reguły, przelewy własne), learning.py (uczenie),
                       # duplicates.py (wykrywanie duplikatów), balances.py (salda rachunków),
                       # currency.py (kursy i przeliczanie), identity.py (numery, telefony, rachunki w bankach),
                       # groups.py (banki jako grupy rachunków, kursy startowe), shops.py (sklepy z reguł)
                       # goal_flows.py (wpłaty/wypłaty celów, także przez rachunki powiązane z celem)
                       # fuzzy.py (wyszukiwanie fuzzy, to samo co frontend/src/fuzzy.ts)
                       # recurring.py (wykrywanie wydatków stałych, to samo co frontend/src/local/recurring.ts)
    seed_demo.py
  tests/
frontend/
  src/
    api.ts, types.ts, context.tsx, settings.tsx (motyw, układ pulpitu), fonts.ts (kroje pisma), format.ts
    mode.ts            # wybór trybu: serwer albo lokalnie na urządzeniu; kopia zapasowa
    fuzzy.ts, ruleGroups.ts  # wyszukiwanie fuzzy; grupy podobnych reguł
    native.ts          # aplikacja iOS (Capacitor): kopia bazy w Plikach, „Udostępnij”, pasek stanu
    local/             # tryb lokalny: importers, engine (reguły, statystyki, salda), router (API), store (zapis),
                       # currency, identity, recurring (jak w backendzie)
    components/        # Layout (pasek + dolna nawigacja), AddSheet (okno „+”), TransactionForm,
                       # TransactionList, ImportReview (okno weryfikacji z uczeniem),
                       # RuleProposals (pytanie o regułę i wyjątki), widgets, ui,
                       # EmojiPicker, AccountSelect, AccountStatsView, CategoryTransactions,
                       # CategoryTrends (średnie wg kategorii w czasie), RecurringCard (wydatki stałe),
                       # avatars (obrazki profilowe)
    pages/             # Login, Dashboard, Stats, Settings
    sections/          # sekcje ustawień: Categories, Shops, Rules, Goals, Accounts, Currencies, Account (konto)
  public/              # ikony, manifest.webmanifest (aplikacja na ekranie początkowym)
  capacitor.config.ts  # aplikacja iOS: identyfikator, nazwa, katalog dist-ios
  ios/                 # projekt Xcode (App.xcodeproj, ikona, ekran startowy, Info.plist)
samples/               # przykładowe wyciągi CSV
Dockerfile, docker-compose.yml  # obraz z frontendem i API, dane w wolumenie /data
deploy/github-pages-iphone.yml  # workflow publikacji wersji na telefon (skopiuj do .github/workflows/)
```

## Uwagi

- Kwoty są przechowywane jako liczby całkowite w groszach — bez błędów zaokrągleń.
- Transakcje w walutach obcych są zapisywane z kodem waluty, ale statystyki sumują kwoty
  bez przeliczania kursów (w eksportach bankowych kwota jest zwykle już w walucie rachunku).
- Przy zmianach schematu w istniejącej bazie warto dodać migracje (np. Alembic).
