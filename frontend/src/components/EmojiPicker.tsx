import { useMemo, useState } from 'react'
import { fuzzyScore } from '../fuzzy'

/** Emoji pogrupowane tematycznie, z polskimi słowami do wyszukiwania. Format: „emoji słowa kluczowe”. */
const GROUPS: { id: string; label: string; icon: string; items: string }[] = [
  {
    id: 'jedzenie',
    label: 'Jedzenie',
    icon: '🛒',
    items: `🛒 zakupy spożywcze market koszyk|🧺 kosz zakupy|🍽️ restauracja obiad|🍴 sztućce jedzenie|🥡 na wynos jedzenie|🍕 pizza|🍔 burger fastfood|🍟 frytki fastfood|🌭 hotdog|🌮 taco meksykańskie|🌯 burrito kebab|🥙 kebab|🥗 sałatka zdrowe|🍣 sushi|🍜 ramen zupa|🍝 makaron|🍛 curry|🥟 pierogi|🍲 zupa gulasz|🍳 śniadanie jajka|🥐 rogalik piekarnia|🥖 pieczywo chleb piekarnia|🍞 chleb|🧀 ser nabiał|🥩 mięso rzeźnik|🍗 kurczak|🐟 ryba|🥦 warzywa|🍎 owoce jabłko|🍌 banan owoce|🍓 truskawki owoce|🥑 awokado|🥕 marchew warzywa|🥚 jajka|🥛 mleko nabiał|🍰 ciasto cukiernia deser|🎂 tort urodziny|🧁 babeczka słodycze|🍩 pączek słodycze|🍫 czekolada słodycze|🍬 cukierki słodycze|🍦 lody|🍿 popcorn kino przekąski|🥨 przekąski precel|🥜 orzechy`,
  },
  {
    id: 'napoje',
    label: 'Napoje',
    icon: '☕',
    items: `☕ kawa kawiarnia|🍵 herbata|🧋 bubble tea|🥤 napój cola|🧃 sok|💧 woda|🍺 piwo pub bar|🍻 piwo impreza|🍷 wino|🥂 szampan impreza|🍸 drink koktajl|🍹 drink wakacje|🥃 whisky alkohol|🍾 szampan świętowanie|🧉 yerba mate`,
  },
  {
    id: 'dom',
    label: 'Dom i rachunki',
    icon: '🏠',
    items: `🏠 dom mieszkanie czynsz|🏡 dom ogród|🏢 blok mieszkanie biuro|🏘️ osiedle wspólnota|🔑 klucze najem wynajem|🛋️ meble kanapa|🛏️ łóżko sypialnia|🪑 krzesło meble|🚪 drzwi remont|🪟 okno|🛁 łazienka wanna|🚿 prysznic woda|🚽 łazienka|🧹 sprzątanie|🧽 środki czystości|🧺 pranie|🧴 kosmetyki chemia|🧻 papier chemia|🔨 remont narzędzia|🪛 naprawa|🧰 narzędzia majsterkowanie|🪴 rośliny kwiaty|🌱 ogród rośliny|💡 prąd rachunki energia|🔌 prąd elektryczność|🔥 gaz ogrzewanie|♨️ ogrzewanie ciepło|🌡️ ogrzewanie|💧 woda rachunki|🗑️ śmieci wywóz odpady|📡 internet telewizja|📶 internet|📺 telewizja tv|📞 telefon abonament|🧾 rachunki faktury opłaty|🛡️ ubezpieczenie|🏦 kredyt hipoteka bank`,
  },
  {
    id: 'transport',
    label: 'Transport',
    icon: '🚗',
    items: `🚗 samochód auto|🚙 auto suv|🚕 taxi taksówka uber bolt|🚌 autobus komunikacja|🚎 trolejbus|🚊 tramwaj|🚇 metro|🚆 pociąg pkp|🚄 pociąg intercity|✈️ samolot lot podróż|🛫 lot wylot|🚲 rower|🛴 hulajnoga|🛵 skuter|🏍️ motocykl|⛽ paliwo benzyna stacja orlen|🔋 ładowanie elektryk|🅿️ parking|🛣️ autostrada opłaty|🚘 samochód|🔧 mechanik serwis naprawa|🛞 opony|🚿 myjnia|🧾 mandat|🚢 prom statek|⛴️ prom|🚁 helikopter|🎫 bilet komunikacja`,
  },
  {
    id: 'zakupy',
    label: 'Zakupy',
    icon: '🛍️',
    items: `🛍️ zakupy galeria|👕 ubrania koszulka|👖 spodnie ubrania|👗 sukienka ubrania|👔 koszula ubrania|🧥 kurtka płaszcz|👟 buty sport|👠 buty szpilki|👜 torebka|🎒 plecak|👓 okulary|🕶️ okulary przeciwsłoneczne|⌚ zegarek|💍 biżuteria pierścionek|💄 kosmetyki makijaż|💅 paznokcie manicure|💇 fryzjer|💈 fryzjer barber|🧴 kosmetyki|🪒 golenie|📦 paczka zamówienie allegro|🎁 prezent upominek|🏷️ promocja wyprzedaż|🧸 zabawki|🪀 zabawki`,
  },
  {
    id: 'technologia',
    label: 'Technologia',
    icon: '💻',
    items: `💻 komputer laptop|🖥️ komputer monitor pc|⌨️ klawiatura|🖱️ mysz myszka|🖲️ trackball|🖨️ drukarka|📱 telefon smartfon iphone|📲 aplikacje telefon app store|☎️ telefon stacjonarny|📞 telefon słuchawka|📟 pager|📠 fax|⌚ zegarek smartwatch|🎧 słuchawki|🎙️ mikrofon podcast nagrywanie|🎚️ mikser audio|🎛️ pokrętła audio studio|🔈 głośnik|🔊 głośnik audio|📻 radio|📺 telewizor tv|📷 aparat|📸 aparat zdjęcia|📹 kamera wideo|🎥 kamera film|📽️ projektor|🎞️ film taśma|🎮 konsola gry pad playstation xbox|🕹️ joystick gry retro|👾 gry retro|💾 dyskietka zapis|💽 dysk|💿 płyta cd|📀 dvd blu-ray|🗄️ serwer archiwum|🗃️ pliki kartoteka|📁 folder pliki|📂 folder|🗜️ kompresja|🔋 bateria powerbank|🪫 słaba bateria|🔌 kabel ładowarka wtyczka|💡 żarówka smart home|🔦 latarka|📡 antena satelita|🛰️ satelita starlink|🚀 rakieta startup|🛸 ufo|🤖 robot ai sztuczna inteligencja chatgpt|🧠 ai mózg nauka|🧑‍💻 programowanie programista praca it|👩‍💻 programistka it|👨‍💻 programista it|☁️ chmura icloud dropbox google drive subskrypcja|🌐 internet strona domena hosting|🔗 link|📶 wifi zasięg internet|📧 email poczta|📨 email wiadomość|📩 email skrzynka|💬 komunikator czat|🗨️ czat wiadomość|🔐 hasło vpn bezpieczeństwo|🔑 klucz licencja|🛡️ antywirus ochrona|🔒 zabezpieczenie|⚙️ ustawienia serwis|🛠️ narzędzia naprawa serwis|🔧 klucz naprawa|🔩 śruba części|🧲 magnes|⚡ prąd energia|🔬 mikroskop nauka|🔭 teleskop|🧪 eksperyment laboratorium|🧬 dna biotech|🧮 liczydło kalkulator|🔍 wyszukiwanie|🔎 lupa szukaj|📈 wykres dane|📊 dane statystyki|💳 płatności online|🪙 krypto token|₿ bitcoin kryptowaluty|🎟️ licencja klucz gry|🧾 abonament subskrypcja|📦 sprzęt zamówienie|🖊️ rysik tablet|📒 notatki|🗓️ kalendarz|⏰ budzik|⏱️ stoper|🧭 nawigacja gps|🗺️ mapy`,
  },
  {
    id: 'zdrowie',
    label: 'Zdrowie i sport',
    icon: '💊',
    items: `💊 apteka leki|🩺 lekarz wizyta|🏥 szpital|🦷 dentysta zęby|👓 okulista|💉 szczepienie|🩹 opatrunek|🧪 badania laboratorium|🧠 psycholog terapia|❤️ zdrowie serce|🩻 rtg badanie|🧘 joga medytacja|🏋️ siłownia fitness|🤸 gimnastyka|🏃 bieganie|🚴 rower sport|🏊 basen pływanie|⚽ piłka nożna|🏀 koszykówka|🎾 tenis|🏸 badminton|🥊 boks|⛷️ narty|🏂 snowboard|🧗 wspinaczka|🥾 góry trekking|💆 masaż spa|🧖 sauna spa`,
  },
  {
    id: 'rozrywka',
    label: 'Rozrywka',
    icon: '🎬',
    items: `🎬 kino film|🍿 kino|🎭 teatr|🎤 koncert karaoke|🎵 muzyka spotify|🎶 muzyka|🎸 gitara instrument|🎹 pianino|🎟️ bilety wydarzenie|🎪 cyrk festiwal|🎡 wesołe miasteczko|🎳 kręgle|🎱 bilard|🎲 gry planszowe|🧩 puzzle|🃏 karty|🎨 sztuka hobby|🖌️ malowanie|📚 książki|📖 książka czytanie|📰 gazeta prasa|📺 streaming netflix|🎧 podcast audiobook|🎮 gry|🎉 impreza|🥳 urodziny impreza|🎊 święto|🎰 hazard|🏟️ stadion mecz`,
  },
  {
    id: 'podroze',
    label: 'Podróże',
    icon: '✈️',
    items: `✈️ podróż samolot|🏖️ wakacje plaża|🏝️ wyspa wakacje|🏔️ góry|⛰️ góry|🏕️ kemping|⛺ namiot kemping|🏨 hotel nocleg|🛎️ hotel|🧳 bagaż walizka|🗺️ mapa wycieczka|🧭 wycieczka|🌍 świat podróż|🗽 zwiedzanie|🏰 zamek zwiedzanie|🎢 park rozrywki|🚐 kamper|🛂 paszport wiza|💱 wymiana waluty kantor|📸 zwiedzanie zdjęcia|🌴 tropiki wakacje|☀️ słońce lato|❄️ zima ferie`,
  },
  {
    id: 'ludzie',
    label: 'Rodzina',
    icon: '👨‍👩‍👧',
    items: `👨‍👩‍👧 rodzina|👶 dziecko niemowlę|🍼 butelka niemowlę|🧒 dziecko|👧 córka|👦 syn|🧑‍🎓 student|🎓 edukacja szkoła studia|🏫 szkoła przedszkole|✏️ przybory szkolne|📝 kurs zajęcia|👵 babcia|👴 dziadek|💑 para randka|💒 ślub wesele|💐 kwiaty|❤️ miłość|🤝 pomoc|🙏 darowizna|🎗️ charytatywne`,
  },
  {
    id: 'zwierzeta',
    label: 'Zwierzęta',
    icon: '🐾',
    items: `🐾 zwierzęta łapy weterynarz|🐶 pies piesek|🐕 pies spacer|🦮 pies przewodnik|🐕‍🦺 pies asystujący|🐩 pudel pies|🐺 wilk|🦊 lis|🦝 szop|🐱 kot kotek|🐈 kot|🐈‍⬛ czarny kot|🦁 lew|🐯 tygrys|🐅 tygrys|🐆 lampart gepard|🐴 koń|🐎 koń wyścigi jazda konna|🦄 jednorożec|🦓 zebra|🦌 jeleń sarna|🦬 żubr bizon|🐮 krowa|🐂 byk|🐃 bawół|🐄 krowa|🐷 świnia świnka|🐖 świnia|🐗 dzik|🐏 baran|🐑 owca|🐐 koza|🐪 wielbłąd|🐫 wielbłąd|🦙 lama alpaka|🦒 żyrafa|🐘 słoń|🦣 mamut|🦏 nosorożec|🦛 hipopotam|🐭 mysz|🐁 mysz|🐀 szczur|🐹 chomik|🐰 królik|🐇 królik zając|🐿️ wiewiórka|🦫 bóbr|🦔 jeż|🦇 nietoperz|🐻 niedźwiedź miś|🐻‍❄️ niedźwiedź polarny|🐨 koala|🐼 panda|🦥 leniwiec|🦦 wydra|🦨 skunks|🦘 kangur|🦡 borsuk|🦃 indyk|🐔 kura kurczak|🐓 kogut|🐣 pisklę|🐤 kurczaczek|🐥 kurczak|🐦 ptak|🐧 pingwin|🕊️ gołąb|🦅 orzeł|🦆 kaczka|🦢 łabędź|🦉 sowa|🦤 dodo|🪶 pióro ptak|🦩 flaming|🦚 paw|🦜 papuga|🐸 żaba|🐊 krokodyl|🐢 żółw|🦎 jaszczurka gekon|🐍 wąż|🐲 smok|🐉 smok|🦕 dinozaur|🦖 dinozaur tyranozaur|🐳 wieloryb|🐋 wieloryb|🐬 delfin|🦭 foka|🐟 ryba rybki akwarium|🐠 rybka tropikalna akwarium|🐡 ryba rozdymka|🦈 rekin|🐙 ośmiornica|🦑 kałamarnica|🦐 krewetka|🦞 homar|🦀 krab|🐚 muszla|🪸 koral rafa|🐌 ślimak|🦋 motyl|🐛 gąsienica|🐜 mrówka|🐝 pszczoła miód|🪲 żuk chrząszcz|🐞 biedronka|🦗 świerszcz|🪳 karaluch|🕷️ pająk|🕸️ pajęczyna|🦂 skorpion|🦟 komar|🪰 mucha|🪱 robak dżdżownica|🦠 mikrob bakteria|🦴 kość karma gryzak|🥩 karma mięso|🩺 weterynarz|💉 szczepienie zwierzęcia|🛁 kąpiel grooming|✂️ strzyżenie grooming|🧶 włóczka zabawka kot|🎾 piłka zabawka pies|🏠 buda legowisko|🌿 siano kocimiętka`,
  },
  {
    id: 'finanse',
    label: 'Finanse i praca',
    icon: '💰',
    items: `💰 pieniądze oszczędności|💵 gotówka|💴 gotówka|💶 euro|💷 funt|💸 wydatki przelew|🪙 monety drobne|💳 karta płatność|🏦 bank|🏧 bankomat|📈 inwestycje giełda zysk|📉 strata spadek|📊 statystyki|💹 akcje|₿ kryptowaluty bitcoin|🧾 podatek faktura|📑 dokumenty|🗂️ dokumenty|💼 praca wynagrodzenie|🏢 firma biuro|👨‍💼 praca|🧑‍🔧 usługi|📮 poczta|✉️ list|🏛️ urząd podatki zus|⚖️ prawnik sąd|🔒 zabezpieczenie|🐷 skarbonka oszczędności|🎯 cel|💎 luksus|🤑 bonus premia|🎰 loteria|🧧 prezent pieniądze|📬 zwrot|↩️ zwrot refundacja|🔁 subskrypcja cykliczne|📅 abonament miesięczne`,
  },
  {
    id: 'symbole',
    label: 'Symbole',
    icon: '⭐',
    items: `⭐ gwiazdka ulubione|🌟 wyróżnienie|✨ nowe|🔥 ważne|⚡ szybkie energia|❗ uwaga|❓ nieznane|✅ gotowe|❌ anulowane|⚠️ ostrzeżenie|🔴 czerwony|🟠 pomarańczowy|🟡 żółty|🟢 zielony|🔵 niebieski|🟣 fioletowy|⚫ czarny|⚪ biały|🟤 brązowy|❤️ czerwone serce|🧡 serce|💛 serce|💚 serce|💙 serce|💜 serce|🖤 serce|🤍 serce|📌 pinezka|📍 miejsce|🏷️ etykieta|🔖 zakładka|🎈 balon|🎀 kokarda|🌈 tęcza|☂️ parasol|🍀 szczęście|🎄 święta boże narodzenie|🎃 halloween|🐣 wielkanoc|🎆 sylwester`,
  },
]

const parsed = GROUPS.map((g) => ({
  ...g,
  list: g.items.split('|').map((x) => {
    const [emoji, ...kw] = x.trim().split(' ')
    return { emoji, kw: kw.join(' ') }
  }),
}))

/** Ostatni znak graficzny (emoji złożone z kilku kodów, np. 👨‍👩‍👧, liczą się jako jeden). */
function lastGrapheme(s: string): string {
  const t = s.trim()
  if (!t) return ''
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => { segment: (x: string) => Iterable<{ segment: string }> } }).Segmenter
  if (Seg) {
    const parts = [...new Seg('pl', { granularity: 'grapheme' }).segment(t)]
    return parts[parts.length - 1]?.segment ?? ''
  }
  return [...t].slice(-2).join('')
}


export function EmojiPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [group, setGroup] = useState(() => parsed.find((g) => g.list.some((e) => e.emoji === value))?.id ?? parsed[0].id)
  const [q, setQ] = useState('')
  const results = useMemo(() => {
    const needle = q.trim()
    if (!needle) return parsed.find((g) => g.id === group)!.list
    const seen = new Set<string>()
    // wyszukiwanie fuzzy (literówki, bez polskich znaków), najlepiej pasujące najpierw
    return parsed
      .flatMap((g) => g.list.map((e) => ({ e, s: fuzzyScore(needle, e.kw, g.label) })))
      .filter((x) => x.s !== null)
      .sort((a, b) => b.s! - a.s!)
      .map((x) => x.e)
      .filter((e) => (seen.has(e.emoji) ? false : (seen.add(e.emoji), true)))
  }, [q, group])

  return (
    <div className="emoji-picker">
      <div className="emoji-top">
        <span className="emoji-current" aria-label="Wybrana ikona">
          {value || '∅'}
        </span>
        <input
          className="emoji-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Szukaj: kot, paliwo, kawa…"
          aria-label="Szukaj emoji"
        />
        <input
          className="emoji-own"
          value={value}
          onChange={(e) => onChange(lastGrapheme(e.target.value).slice(0, 16))}
          placeholder="własne"
          aria-label="Własne emoji (wpisz z klawiatury)"
          maxLength={16}
        />
      </div>
      {!q && (
        <div
          className="emoji-tabs"
          role="tablist"
          onWheel={(e) => {
            // kółko myszy przewija pasek kategorii w bok (na komputerze nie ma gestu przesunięcia)
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
          }}
        >
          {parsed.map((g) => (
            <button
              type="button"
              key={g.id}
              role="tab"
              aria-selected={group === g.id}
              className={group === g.id ? 'active' : ''}
              onClick={() => setGroup(g.id)}
              title={g.label}
            >
              <span>{g.icon}</span>
              <span className="emoji-tab-label">{g.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="emoji-grid">
        {results.map((e) => (
          <button type="button" key={e.emoji} title={e.kw} className={value === e.emoji ? 'active' : ''} onClick={() => onChange(value === e.emoji ? '' : e.emoji)}>
            {e.emoji}
          </button>
        ))}
        {!results.length && <div className="small muted emoji-empty">Brak wyników — możesz wpisać własne emoji w polu obok.</div>}
      </div>
    </div>
  )
}
