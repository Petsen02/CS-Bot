# CS-Bot

Twitch-chatbot der viser Counter-Strike 2-rangdata for en liste af spillere:
**FACEIT-elo** og **ESEA League**, begge via FACEIT's officielle API.

Søsterprojekt til [LoL Twitch Bot](https://github.com/Petsen02/TwitchBot).
Kommandonavnene er med vilje de samme, så seere og mods ikke skal lære et nyt
sæt for at følge en anden titel i samme chat.

> **Ansvarsfraskrivelse**
>
> CS-Bot is not endorsed by Valve Corporation or FACEIT and does not reflect
> the views or opinions of either. Counter-Strike and all associated properties
> are trademarks or registered trademarks of Valve Corporation.

## FACEIT og ESEA — ikke Premier

Botten dækker to ting, og de er bevidst holdt adskilt:

- **FACEIT-elo** — et personligt tal der flytter sig hver kamp. `!rank`,
  `!session`, `!nextrank`, `!lastgame`, `!lobby`, `!top`, `!maps`.
- **ESEA League** — en **holdliga** med sæsoner og divisioner. `!esea` viser
  holdets division, sæsonrekord og placering.

Der findes ikke noget personligt "ESEA-tal" der svarer til elo, så de to kan
ikke sammenlignes eller lægges sammen. Derfor er `!esea` sin egen kommando og
ikke en linje i `!rank`.

**Valve's Premier er ikke med**, og det er et valg, ikke en mangel: Valve
udstiller ikke CS Rating gennem noget API, og de projekter der alligevel læser
det, snakker uofficielt med Valves Game Coordinator via en lokal spilklient.

ESEA kører i øvrigt på FACEIT's egen platform — ESEA drives af ESL FACEIT
Group — så begge dele kommer fra samme API med samme nøgle og samme
rate limit-budget.

## Status

Tidlig. Al logik der kan køre uden netværk er skrevet og dækket af tests
(`npm test`), men **intet er endnu kørt mod det rigtige FACEIT API** — det var
blokeret i miljøet koden blev skrevet i. Feltnavne og stier i `src/faceit.js`
er derfor markeret som ubekræftede.

`npm run check <nick>` findes netop for at lukke det hul: den kalder hvert
endpoint botten bruger og siger hvilke felter der manglede.

## Kommandoer

Hver kanal har sin egen spillerliste, main, region og land, så én bot kan
betjene flere streamere uden at de ser hinandens spillere.

| Kommando | Svar |
|---|---|
| `!rank [nick]` | `PETSEN LEVEL10: 2347 elo` — top 1000 i regionen får også `(Rank#412)` |
| `!ranks` | Kanalens liste, nummereret, højeste elo først |
| `!session` / `!gains` `[nick]` | `PETSEN: 3W 2L (+47 elo) 🟩🟩🟥🟩🟥` for i dag |
| `!nextrank [nick]` | `PETSEN LEVEL9: 1920 elo │ mangler 81 elo til LEVEL10 (ca 4 wins)` |
| `!lastgame [nick]` | `PETSEN │ Mirage 13-9 W │ 24-17-6 │ 1.41 K/D │ 94.2 ADR │ 48% HS │ +25 elo` |
| `!lobby [nick]` | Gennemsnitselo pr. hold i den igangværende kamp |
| `!top [nick]` | `PETSEN LEVEL10: 2347 elo │ DK #12 │ EU #418` |
| `!maps [nick]` | `PETSEN │ bedst Nuke 68% (31) │ værst Ancient 38% (24)` |
| `!esea [nick]` | `PETSEN │ ESEA Advanced Group C │ Nordic Noobs 7-3 │ #4` |

Alle kommandoer tager et FACEIT-nick, et SteamID64 eller et link til en
Steam- eller FACEIT-profil. Uden argument svarer de om kanalens main.

### Hvorfor `!top` og ikke `!chal`

LoL-botten viser Challenger- og Grandmaster-cutoffs, fordi Riot udstiller
dem. FACEIT har ikke cutoffs — den har ranglister. `!top` viser derfor din
placering i stedet.

Der står `EU`, ikke "verden": **FACEIT's ranglister er altid regionale**, da
regionen er en del af API-stien. Der findes ikke noget globalt tal at hente, og
at skrive "verden" over en regionsplacering ville være en påstand API'et ikke
kan bakke op.

### ESEA er en holdliga

`!esea` svarer om et hold, ikke om en person. Spiller streameren ikke ESEA
League i den igangværende sæson, siger botten det direkte frem for at vise
`0-0`.

Sæsonen slås op automatisk ud fra ligaen, så en ny ESEA-sæson kræver ingen
ændring og ingen udrulning. Kører der ingen sæson lige nu, vises den seneste
der er begyndt, så svaret bliver "sidste sæson sluttede sådan" frem for
ingenting. Kun liga-id'et står i `.env`, som `ESEA_LEAGUE_ID`.

## Admin-kommandoer

Alt der styrer kanalens opsætning har præfikset `!old`, og er lukket for
almindelige seere.

| Kommando | Hvem | Virkning |
|---|---|---|
| `!oldcommands` | alle | Linker hertil |
| `!oldplayerlist` | mod | Viser kanalens region, land og spillerliste |
| `!oldaddplayer <nick>` | mod | Tilføjer, efter at kontoen er slået op hos FACEIT |
| `!oldremoveplayer <nick>` | mod | Fjerner fra listen |
| `!oldaddmain <nick>` | mod | Sætter main, og tilføjer til listen hvis den mangler |
| `!oldremovemain <nick>` | mod | Fjerner main |
| `!oldregion EU` | mod | Sætter kanalens region — `EU`, `NA`, `SA`, `AS`, `OCE` |
| `!oldcountry dk` | mod | Sætter landet `!top` måler mod |

## Level og elo

Faste grænser, ingen API-opslag. Level 10 har ingen øvre grænse.

| Level | Elo | | Level | Elo |
|---|---|---|---|---|
| 1 | 100–500 | | 6 | 1 201–1 350 |
| 2 | 501–750 | | 7 | 1 351–1 530 |
| 3 | 751–900 | | 8 | 1 531–1 750 |
| 4 | 901–1 050 | | 9 | 1 751–2 000 |
| 5 | 1 051–1 200 | | 10 | 2 001+ |

Grænserne står samlet i `src/elo.js`. De har flyttet sig historisk, så skal de
justeres, er det én diff. `npm run check` sammenligner vores tabel med FACEIT's
eget `skill_level` og siger til hvis de er uenige.

## Hvor elo-tallene kommer fra

FACEIT udstiller nuværende elo, men **ingen elo pr. kamp**. Hvert elo-tal
`!session` og `!lastgame` viser er derfor målt af botten selv: den tager et
snapshot af hver tracket spillers elo, og når en ny kamp dukker op, tilskrives
ændringen den kamp.

Det har to konsekvenser, som svarene er ærlige om:

- **Kun spillere på kanalens liste trackes.** Spørger du om en tilfældig
  spiller, kan botten vise rank og statistik, men ikke elo-ændringer.
- **Falder to kampe i samme målevindue**, kan ændringen ikke fordeles mellem
  dem uden at gætte. Kampene bogføres så med resultat men uden elo, og
  `!session` skriver `[3/5 målt]` frem for et forkert totaltal.

`data/tracker.json` er derfor den eneste fil der ikke kan genskabes fra API'et.
Skrivninger er atomare, og tilstanden gemmes også ved SIGTERM og nedbrud.

## Rang-ikoner med 7TV

Botten skriver levelet som et almindeligt ord — `LEVEL10` — og 7TV bytter det
ud med et ikon hos dem der har udvidelsen installeret. Navnene skal være
præcis disse, med store bogstaver — 7TV skelner:

```
LEVEL1  LEVEL2  LEVEL3  LEVEL4  LEVEL5  LEVEL6  LEVEL7  LEVEL8  LEVEL9  LEVEL10
```

Mangler én af dem, skriver botten bare navnet som tekst på den linje. Uden
udvidelsen ser seerne `LEVEL10: 2347 elo` som ren tekst, hvilket stadig læses
fint. Vil du helt undgå ikonerne, sættes `RANK_STYLE=letters`, og så skriver
botten `L10 2347elo`.

Et 7TV-sæt med FACEIT-level-ikoner er endnu ikke lavet.

## Kom i gang

```bash
npm install
cp .env.example .env     # udfyld FACEIT_API_KEY og Twitch-felterne
npm run check PETSEN     # smoke test mod FACEIT, uden Twitch
npm test                 # ren logik, intet netværk
npm start
```

En API-nøgle oprettes i FACEIT's Developer Portal under App Studio.

Alle indstillinger er dokumenteret i `.env.example`. Vær opmærksom på
`FACEIT_LIMIT_PER_SECOND` og `FACEIT_LIMIT_PER_TEN_MINUTES`: de er sat
konservativt, fordi FACEIT's faktiske budget endnu ikke er bekræftet.

## Drift

`deploy/cs-bot.service` er en systemd-unit. Den genstarter botten ved nedbrud
og sender SIGTERM ved stop, så dagens målte elo bliver gemt.

```bash
sudo cp deploy/cs-bot.service /etc/systemd/system/
sudo systemctl enable --now cs-bot
journalctl -u cs-bot -f
```

Botten skriver også sin egen log til `logs/`, med en fil pr. dag, og lægger
hver uhåndteret fejl i `logs/crashes/` med fuld stak.

## Datakilder

- Elo, level, kampe, igangværende kampe og ranglister:
  [FACEIT Data API](https://docs.faceit.com/docs/data-api/)
- ESEA League: samme API's league-endpoints
  (`/leagues/{id}`, `/leagues/{id}/seasons/{id}/players/{id}`).
  **Ikke** `play.esea.net`, som er Cloudflare-beskyttet og kun kan skrabes
  uofficielt — se [ESEA League på FACEIT](https://www.faceit.com/en/esealeague)
- Mapnavne: statisk tabel i `src/maps.js`

Pro-opslag i `!lobby`, svarende til LoL-bottens lolpros.gg-integration, er ikke
med: HLTV har ingen officiel API.
