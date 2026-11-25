export type CategoryKind = 'expense' | 'income'
export type TransactionType =
  | 'expense'
  | 'income'
  | 'saving_deposit'
  | 'saving_withdrawal'
  | 'transfer_out'
  | 'transfer_in'

export type RuleField = 'title' | 'counterparty' | 'counterparty_account' | 'description'
export type RuleDirection = 'any' | 'expense' | 'income'

export interface Account {
  id: number
  name: string
  bank: string
  number: string | null
  /** wszystkie numery: rachunki (26 cyfr) i końcówki kart (4 cyfry) */
  numbers: string[]
  /** telefony do BLIK na telefon (9 cyfr albo z prefiksem kraju) */
  phones: string[]
  /** waluta konta (kod ISO), np. PLN, EUR */
  currency: string
  /** subkonto: id konta głównego (np. Revolut EUR → Revolut) */
  parent_id: number | null
  /** produkt Revoluta (np. „Savings”), gdy subkonto to skarbonka */
  product: string | null
  /** konto główne = folder na subkonta: bez numerów, telefonów i własnych operacji; saldo = suma subkont w zł */
  is_group?: boolean
  color: string
  savings_goal_id: number | null
  savings_goal_name: string | null
  archived: boolean
  transaction_count: number
  last_date: string | null
  total_in: number
  total_out: number
  /** szacowane saldo na dziś w walucie konta (z kolumny „saldo po transakcji” w wyciągach albo z salda wpisanego ręcznie) */
  balance: number | null
  /** saldo przeliczone na złote wg aktualnego kursu */
  balance_pln: number | null
  balance_known: boolean
  balance_source: 'csv' | 'manual' | null
  balance_date: string | null
  balance_anchor: number | null
  balance_anchor_date: string | null
}

export interface AccountStatsPoint {
  key: string
  balance: number | null
  income: number
  expense: number
  net: number
}

export interface AccountStatsRow {
  id: number
  name: string
  bank: string
  color: string
  archived: boolean
  /** waluta konta — kwoty w tym wierszu są w tej walucie (poza polami *_pln) */
  currency: string
  parent_id: number | null
  balance: number | null
  balance_pln: number | null
  start_balance_pln: number | null
  end_balance_pln: number | null
  balance_known: boolean
  balance_source: 'csv' | 'manual' | null
  balance_date: string | null
  start_balance: number | null
  end_balance: number | null
  change: number | null
  income: number
  expense: number
  saving_deposit: number
  saving_withdrawal: number
  transfer_in: number
  transfer_out: number
  net_flow: number
  count: number
  transaction_count: number
  first_date: string | null
  last_date: string | null
  avg_monthly_income: number
  avg_monthly_expense: number
  top_categories: { category_id: number | null; name: string; color: string; icon: string | null; total: number }[]
  series: AccountStatsPoint[]
}

export interface AccountStats {
  date_from: string
  date_to: string
  granularity: 'day' | 'week' | 'month'
  accounts: AccountStatsRow[]
  total: {
    balance: number | null
    start_balance: number | null
    end_balance: number | null
    series: { key: string; balance: number | null }[]
  }
  goals: GoalStatsRow[]
  has_unassigned: boolean
}

export interface User {
  id: number
  username: string
  name: string
  /** obrazek profilowy (id z avatars.tsx) */
  avatar?: string | null
  created_at: string
}

export interface Category {
  id: number
  name: string
  kind: CategoryKind
  color: string
  icon: string | null
  monthly_budget: number | null
  transaction_count: number
}

export interface SavingsGoal {
  id: number
  name: string
  target_amount: number | null
  target_date: string | null
  color: string
  archived: boolean
  balance: number
  deposited: number
  withdrawn: number
  progress: number | null
  monthly_needed: number | null
  last_activity: string | null
  /** stan wpisany ręcznie na koniec dnia balance_anchor_date (wpłaty/wypłaty liczone są po nim) */
  balance_anchor: number | null
  balance_anchor_date: string | null
}

export interface Transaction {
  id: number
  date: string
  /** w złotych (waluty obce — wg aktualnego kursu) */
  amount: number
  /** w walucie operacji (`currency`) */
  amount_orig?: number | null
  type: TransactionType
  category_id: number | null
  category_name: string | null
  category_color: string | null
  savings_goal_id: number | null
  savings_goal_name: string | null
  description: string
  note: string | null
  currency: string
  source: string
  import_batch_id: number | null
  account_id: number | null
  account_name: string | null
  transfer_account_id: number | null
  transfer_account_name: string | null
  counterparty: string | null
  counterparty_account: string | null
  title: string | null
  /** przelew własny: druga strona */
  pair_id?: number | null
  /** wpływ będący zwrotem: wydatek, którego dotyczy */
  refund_of_id?: number | null
  refund_of_label?: string | null
  /** wydatek: ile już wróciło zwrotami */
  refunded?: number | null
  shop_id?: number | null
  shop_name?: string | null
  /** wydatek stały, do którego należy transakcja */
  recurring_id?: number | null
  recurring_name?: string | null
  learned_pattern?: string | null
  proposal?: RuleProposal | null
}

export interface Shop {
  id: number
  name: string
  /** kolor (#rrggbb) i emoji sklepu; null = wygląd domyślny */
  color: string | null
  icon: string | null
  transaction_count: number
  rule_count: number
  /** najczęstsza kategoria reguł tego sklepu — podpowiedź w formularzu */
  category_id: number | null
}

export interface ShopStatsRow {
  shop_id: number
  name: string
  color: string | null
  icon: string | null
  count: number
  total: number
  avg: number
  /** zakupy na miesiąc i średni odstęp między dniami zakupów (dni) */
  per_month: number
  avg_gap_days: number | null
  /** udział w wydatkach okresu (0–1) */
  share: number
  first_date: string
  last_date: string
  /** pierwszy zakup w całej historii (nowy sklep, gdy w wybranym okresie) */
  first_ever: string
  days_since_last: number
  min: number
  max: number
  median: number
  /** liczba zakupów w dniach tygodnia: pn … nd */
  weekdays: number[]
  months: { month: string; count: number; total: number }[]
  /** ten sam sklep w poprzednim okresie tej samej długości */
  previous: { count: number; total: number }
  categories: {
    category_id: number | null
    name: string
    color: string
    icon: string | null
    count: number
    total: number
    /** jaka część wydatków tej kategorii w okresie przypada na ten sklep */
    category_share: number
  }[]
}

export interface ShopStats {
  date_from: string
  date_to: string
  shops: ShopStatsRow[]
  total: number
  count: number
  with_shop_count: number
  with_shop_total: number
  months: string[]
  /** wydatki ze sklepem w poprzednim okresie */
  previous_total: number
}

export interface RefundCandidate {
  transaction: Transaction
  reason: string
  score: number
  /** ile jeszcze nie wróciło */
  remaining: number
}

export interface RuleMatch {
  id: number
  date: string
  amount: number
  type: TransactionType
  description: string
  account_name: string | null
}

export interface RuleProposal {
  kind: 'new_rule' | 'conflict'
  rule_id: number
  field: RuleField
  pattern: string
  direction: RuleDirection
  exclude_pattern: string | null
  target_label: string
  new_target_label: string | null
  match_count: number
  matches: RuleMatch[]
  /** tylko po stronie klienta: transakcja, która wywołała propozycję */
  transaction_id?: number
}

export interface RuleSuggestion {
  key: string
  field: RuleField
  pattern: string
  direction: RuleDirection
  category_id: number
  target_label: string
  based_on: number
  would_fill: number
  examples: string[]
}

export interface TimePoint {
  key: string
  income: number
  expense: number
  net_savings: number
  balance: number
  cumulative_balance: number
  cumulative_expense: number
}

export interface TransactionInput {
  date: string
  amount: number
  type: TransactionType
  category_id: number | null
  savings_goal_id: number | null
  description: string
  note: string | null
  currency?: string
  account_id?: number | null
  transfer_account_id?: number | null
  counterparty?: string | null
  /** wpływ jako zwrot za wydatek (null = zwykły wpływ) */
  refund_of_id?: number | null
  shop_id?: number | null
}

export interface TransactionPage {
  items: Transaction[]
  total: number
  sum_income: number
  sum_expense: number
}

export interface RuleInput {
  pattern: string
  exclude_pattern?: string | null
  auto?: boolean
  field: RuleField
  direction: RuleDirection
  category_id: number | null
  savings_goal_id: number | null
  mark_transfer: boolean
  transfer_account_id: number | null
  priority: number
  shop_id?: number | null
  /** nowy albo istniejący sklep po nazwie; puste = reguła bez sklepu */
  shop_name?: string | null
  /** kolejne wzorce tej samej reguły — każdy z własnym polem; wystarczy, że pasuje jeden */
  extra_patterns?: { pattern: string; field: RuleField }[]
  /** pasujące wydatki to wydatek stały (wymaga kategorii wydatków) */
  mark_recurring?: boolean
  /** przy tworzeniu reguły z wykrytego wydatku stałego: reguła go przejmuje */
  recurring_id?: number | null
}

export interface Rule extends RuleInput {
  id: number
  auto: boolean
  hits: number
  excluded_count: number
  category_name: string | null
  savings_goal_name: string | null
  transfer_account_name: string | null
  shop_id: number | null
  shop_name: string | null
}

export interface RuleTest {
  count: number
  samples: { id: number; date: string; amount: number; type: TransactionType; description: string; category_name: string | null }[]
}

export interface Overview {
  date_from: string
  date_to: string
  days: number
  months: number
  income: number
  expense: number
  saving_deposit: number
  saving_withdrawal: number
  net_savings: number
  balance: number
  free_cash: number
  savings_rate: number | null
  avg_monthly_income: number
  avg_monthly_expense: number
  avg_monthly_savings: number
  avg_daily_expense: number
  transaction_count: number
  uncategorized_count: number
  transfer_out: number
  transfer_in: number
  transfer_count: number
  previous: { date_from: string; date_to: string; income: number; expense: number; net_savings: number }
}

export interface MonthlyPoint {
  month: string
  income: number
  expense: number
  saving_deposit: number
  saving_withdrawal: number
  net_savings: number
  balance: number
}

export interface CategoryStatsBlock {
  total: number
  count: number
  share: number
  avg_per_transaction: number
  avg_per_day: number
  avg_per_week: number
  avg_per_month: number
  median_per_month: number
  max_month: { month: string; total: number } | null
  months_active: number
  min_transaction: number | null
  max_transaction: number | null
  monthly_budget: number | null
  budget_usage: number | null
  monthly: { month: string; total: number }[]
  /** sumy w tygodniach od poniedziałku (pierwszy i ostatni mogą być niepełne) */
  weekly: { week: string; total: number }[]
}

export interface CategoryStatsRow extends CategoryStatsBlock {
  category_id: number | null
  name: string
  color: string
  icon: string | null
}

export interface CategoryStats {
  date_from: string
  date_to: string
  days: number
  months: number
  kind: CategoryKind
  total: number
  avg_per_month: number
  month_keys: string[]
  week_keys: string[]
  categories: CategoryStatsRow[]
}

export interface CategoryDetail extends CategoryStatsRow {
  kind: CategoryKind
  date_from: string
  date_to: string
  days: number
  months: number
  previous_total: number
  previous_avg_per_month: number
  weekday: { day: string; total: number; count: number }[]
  weekly: { week: string; total: number }[]
  amount_histogram: { range: string; count: number }[]
  top_descriptions: { description: string; total: number; count: number }[]
  top_shops: { shop_id: number; name: string; count: number; total: number }[]
  with_shop: number
  largest: { id: number; date: string; amount: number; description: string }[]
}

export type DuplicateLevel = 'exact' | 'probable' | 'possible' | 'similar'

export interface DuplicateHit {
  transaction: Transaction
  reason: string
}

/** Przelew własny: z konta lub celu na konto lub cel. */
export interface TransferInput {
  date: string
  /** w walucie konta źródłowego */
  amount: number
  /** w walucie konta docelowego, gdy jest inna (np. wymiana PLN → EUR); brak = z kursu */
  to_amount?: number | null
  from_account_id?: number | null
  from_goal_id?: number | null
  to_account_id?: number | null
  to_goal_id?: number | null
  description?: string
  note?: string | null
}

export interface GoalStatsRow {
  id: number
  name: string
  color: string
  archived: boolean
  target_amount: number | null
  linked_account: string | null
  balance: number
  balance_anchor: number | null
  balance_anchor_date: string | null
  start_balance: number
  end_balance: number
  change: number
  deposits: number
  withdrawals: number
  count: number
  /** saldo celu na koniec przedziału oraz wpłaty i wypłaty w przedziale */
  series: { key: string; balance: number | null; deposits: number; withdrawals: number }[]
}

export interface DuplicateMatch {
  source: 'db' | 'file'
  id?: number
  file_index?: number
  filename?: string
  date: string
  amount: number
  description: string
  account_name?: string | null
  category_name?: string | null
}

export interface ImportRow {
  file_index: number
  date: string
  amount: number
  description: string
  title: string | null
  counterparty: string | null
  counterparty_account: string | null
  currency: string
  /** równowartość w złotych wg aktualnego kursu */
  amount_pln?: number | null
  balance: number | null
  /** konto/subkonto wiersza (np. Revolut EUR); null = konto pliku */
  account_id?: number | null
  product?: string | null
  type: TransactionType
  category_id: number | null
  savings_goal_id: number | null
  transfer_account_id: number | null
  shop_id?: number | null
  note: string | null
  reason: string | null
  learn_field: RuleField | null
  learn_pattern: string | null
  hash: string
  duplicate: DuplicateLevel | null
  duplicate_of: DuplicateMatch | null
  duplicate_reason: string | null
  /** przelew własny sparowany z wierszem innego pliku (hash) albo transakcją w bazie */
  pair_hash: string | null
  pair_tx_id: number | null
  /** typ operacji z wyciągu (do dopasowania reguł) */
  raw_type?: string | null
  /** zwrot powiązany z wydatkiem: w bazie (id) albo wierszem tego importu (hash) */
  refund_of_id?: number | null
  refund_of_hash?: string | null
  refund_of_label?: string | null
  include: boolean
}

export interface ImportFileInfo {
  index: number
  filename: string
  bank: string | null
  bank_label: string | null
  account_id: number | null
  account_detected: boolean
  statement_account: string | null
  closing_balance: number | null
  row_count: number
  date_from: string | null
  date_to: string | null
  existing_in_range: number
  skipped_lines: number
  warnings: string[]
  error: string | null
  currencies?: string[]
  missing_rates?: string[]
  /** waluty bez subkonta — subkonto powstanie przy zatwierdzeniu */
  missing_subaccounts?: string[]
}

export interface ImportCommitResult {
  batches: ImportBatch[]
  imported_count: number
  skipped_count: number
  learned_rules: number
  proposals: RuleProposal[]
  /** subkonta walutowe założone przy imporcie */
  created_accounts?: string[]
}

export interface CurrencyRates {
  base: string
  /** 1 jednostka waluty = tyle złotych */
  rates: Record<string, number>
  /** waluty używane przez konta i transakcje */
  used: string[]
  /** używane, ale bez kursu (liczone 1:1) */
  missing: string[]
  common: string[]
  /** ile transakcji przeliczono po zapisaniu kursów */
  updated: number | null
}

export interface LearnRule {
  field: RuleField
  pattern: string
  direction: RuleDirection
  category_id: number | null
  savings_goal_id: number | null
  mark_transfer: boolean
  transfer_account_id: number | null
  /** poprawiona w pełnym formularzu w oknie importu — zapisze się jako Twoja reguła */
  edited?: boolean
  extra_patterns?: { pattern: string; field: RuleField }[]
  exclude_pattern?: string | null
  priority?: number
  shop_id?: number | null
  shop_name?: string | null
  mark_recurring?: boolean
}

/** Wydatek stały (wykryty automatycznie). */
export interface Recurring {
  id: number
  name: string
  key: string
  /** numer rachunku albo źródło odbiorcy (null = tylko dołączone ręcznie) */
  payee: string | null
  by_account: boolean
  currency: string
  /** typowa kwota w walucie operacji */
  amount: number
  /** typowa kwota w zł */
  amount_pln: number
  last_amount: number | null
  first_amount: number | null
  period_days: number
  cadence: string
  /** równowartość miesięczna (zł) */
  monthly: number
  count: number
  first_date: string | null
  last_date: string | null
  next_date: string | null
  active: boolean
  dismissed: boolean
  custom_name: boolean
  category_id: number | null
  category_name: string | null
  category_color: string | null
  category_icon: string | null
  excluded_count: number
  /** reguła z opcją „wydatek stały”, która go tworzy (null = wykryty automatycznie) */
  rule_id: number | null
  rule_pattern: string | null
  /** tylko w statystykach: suma i liczba płatności w wybranym okresie */
  period_total?: number
  period_count?: number
}

export interface RecurringList {
  items: Recurring[]
  /** tolerancja odstępu i kwoty w procentach */
  interval_tol: number
  amount_tol: number
  created?: number
}

export interface RecurringStats extends RecurringList {
  date_from: string
  date_to: string
  monthly_total: number
  yearly_total: number
  active_count: number
  ended_count: number
  period_total: number
  period_expense: number
  share: number | null
  avg_monthly: number
  months: { month: string; fixed: number; variable: number }[]
}

export interface ImportPreview {
  files: ImportFileInfo[]
  rows: ImportRow[]
  warnings: string[]
}

export interface ImportBatch {
  id: number
  bank: string
  account_id: number | null
  filename: string
  imported_count: number
  skipped_count: number
  created_at: string
}
