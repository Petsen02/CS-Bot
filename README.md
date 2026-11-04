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
  holdets division, rekord og placering. Se afsnittet nedenfor.

**Valve's Premier er ikke med**, og det er et valg, ikke en mangel: Valve
udstiller ikke CS Rating gennem noget API, og de projekter der alligevel læser
det, snakker uofficielt med Valves Game Coordinator via en lokal spilklient.

ESEA kører i øvrigt på FACEIT's egen platform — ESEA drives af ESL FACEIT
Group — så begge dele kommer fra samme API med samme nøgle og samme
rate limit-budget.

## Status

Verificeret mod det rigtige FACEIT API med to spillere, level 7 og level 10.
Alt botten er afhængig af kom tilbage som forventet.

**Bekræftet:** spilleropslag (elo, level, SteamID, land), elo→level-tabellen,
kamphistorik, kampdetaljer, hele statistiklinjen til `!lastgame`,
map-segmenterne til `!maps`, regionsplaceringen til `!top` og `!rank`, og hele
ESEA-kæden — 59 divisioner, 179 hold i en stilling, placeringer udledt rigtigt.

**Virker ikke:**

- **FACEIT Rating og Round Swing** er ikke i Data API'et. Set på to spillere og
  tre kampe: 47 felter, ingen af dem. Se afsnittet om `!lastgame`.
- **Landeplaceringen i `!top`.** Regionen virker, men `country`-filteret giver
  intet selv for en spiller der står som `EU #6025`.

**Uprøvet:** `!esea` er aldrig kørt mod en spiller der faktisk var på et
ESEA-hold — ingen af testspillerne spillede S55. Kæden er bekræftet i begge
ender, men selve matchet mellem et holds id og en stilling mangler et rigtigt
tilfælde.

`!session` kan først verificeres når botten har kørt en dag og målt elo selv.

`npm run check <nick>` kalder hvert endpoint botten bruger og siger hvilke
felter der manglede.

## Kommandoer

Hver kanal har sin egen spillerliste, main, region og land, så én bot kan
betjene flere streamere uden at de ser hinandens spillere.

| Kommando | Svar |
|---|---|
| `!rank [nick]` | `PETSEN LVL10 2347 elo` — top 1000 i regionen får også `(Rank#412)` |
| `!ranks` | Kanalens liste, nummereret, højeste elo først |
| `!session` / `!gains` `[nick]` | `PETSEN: 3W 2L (+47 elo) 🟩🟩🟥🟩🟥` for i dag |
| `!nextrank [nick]` | `PETSEN LVL9 1920 elo │ mangler 81 elo til LVL10 (ca 4 wins)` |
| `!lastgame [nick]` | Fuld statistiklinje — se nedenfor |
| `!lobby [nick]` | Gennemsnitselo pr. hold i den igangværende kamp |
| `!top [nick]` | `PETSEN LVL10 2347 elo │ DK #12 │ EU #418` |
| `!maps [nick]` | `PETSEN │ bedst Nuke 68% (31) │ værst Ancient 38% (24)` |
| `!esea [nick]` | `vigg0 │ ESEA S55 Advanced │ SPARTA 8-0 │ #1 af 16 │ 24 pts` |


Alle kommandoer tager et FACEIT-nick, et SteamID64 eller et link til en
Steam- eller FACEIT-profil. Uden argument svarer de om kanalens main.

Usynlige tegn fjernes først. Twitch-klienter hænger dem på beskeder for at
omgå dublet-filteret — U+E0000 og U+034F er begge set i praksis — og uden
rensningen ryger de med ind i opslaget. Botten bruger Unicodes egen
`Default_Ignorable_Code_Point`, så også de varianter der endnu ikke er dukket
op bliver fanget. Et indledende `@` fjernes også.

Nicket behøver ikke ramme store og små bogstaver. FACEIT's eget opslag er
versalfølsomt — `vigg0` findes, `Vigg0` giver 404 — så botten falder tilbage
til søgningen og tager det resultat der er identisk bortset fra versaler.
Kun et eksakt match: søgningen er fuzzy, og at svare om en tilfældig anden
spiller ville være værre end at sige at nicket ikke findes.

### Hvorfor `!top` og ikke `!chal`

LoL-botten viser Challenger- og Grandmaster-cutoffs, fordi Riot udstiller
dem. FACEIT har ikke cutoffs — den har ranglister. `!top` viser derfor din
placering i stedet.

Der står `EU`, ikke "verden": **FACEIT's ranglister er altid regionale**, da
regionen er en del af API-stien. Der findes ikke noget globalt tal at hente, og
at skrive "verden" over en regionsplacering ville være en påstand API'et ikke
kan bakke op.

**Landeplaceringen virker måske ikke.** En spiller der står som `#6024` på
EU-ranglisten fik ingen DK-placering, og en delmængde af EU kan ikke mangle
ham — så `country`-filteret ser ikke ud til at virke på den rute. Derfor
udelades en placering der mangler, frem for at blive kaldt "uden for listen".
Kommer kun regionen med, er det den du ser.

### Hvad `!lastgame` viser

```
vigg0 │ Ancient 13-9 W │ 25-15-7 │ 1.50 HLTV │ 1.67 K/D │ 1.14 K/R │ 125.6 ADR
      │ 2763 dmg │ 72% HS │ 7 flashed │ +28 elo │ 74 util dmg │ 3 entry │ 5 MVP
```

Felterne står i prioritetsrækkefølge og tilføjes så længe der er plads. Det er
ikke pynt: Twitch afviser beskeder over 500 tegn, og en blind afklipning ville
efterlade `+25 el` eller `1.1` — tal der ser ud som fakta, men er forkerte.
Derfor rammes grænsen altid mellem felter, og et helt felt udelades frem for at
vise et halvt. Med alt udfyldt er linjen omkring 190 tegn, så det sker sjældent.

Felter uden data udelades også. `0.0 ADR` ville læses som "spillede og lavede
ingen skade", hvor sandheden er at FACEIT ikke oplyste det.

**`HLTV` er HLTV Rating 1.0, regnet af kampens egne tal.** Den bruger kun
kills, deaths, runder og multi-kills, og alle fem er i svaret — så det er den
samme udregning HLTV selv offentliggjorde, ikke et opfundet tal. Feltet hedder
`HLTV` og ikke `rating`, netop så det ikke forveksles med FACEIT's egen.

**FACEIT Rating og Round Swing er ikke med**, og det er målt, ikke gættet. Et
rigtigt kald mod `/matches/{id}/stats` returnerer 47 felter, og hverken rating
eller swing er blandt dem under noget navn. De to findes kun i FACEIT's
web-UI. Koden læser dem stadig, under flere navne, så de dukker op af sig selv
hvis FACEIT føjer dem til API'et.

Rating 2.0 kan ikke regnes: den kræver KAST, som heller ikke er i svaret.

`K/R` og `ADR` udregnes fra kills, damage og rundeantal hvis FACEIT ikke sender
dem direkte — begge kan udledes præcist, så der er ingen grund til et hul.
`elo` er det eneste felt FACEIT ikke leverer: det er målt af botten selv.

`entry` er **First Kills**, ikke `Entry Count`. Svaret har begge, og Count er
antal forsøg — at vise det som entry kills ville overdrive hvad spilleren
faktisk åbnede runder med.

### ESEA er en holdliga

`!esea` svarer om et hold, ikke om en person. Der findes intet personligt
ESEA-tal der svarer til FACEIT-elo, så den er sin egen kommando frem for en
linje i `!rank`.

**Hvordan ESEA ligger i API'et** — kortlagt med `npm run probe-esea`, for det
er ikke oplagt:

- ESEA er **ikke** en "league". Alle `/leagues`-ruter svarer 404.
- ESEA er en **organizer**: `08b06cfc-74d0-454b-9a51-feda4b6b18da`.
- Divisionerne er **championships** under den — 543 i alt.
- Stillingen kræver to kald: `/leaderboards/championships/{id}` giver et
  `leaderboard_id`, og `/leaderboards/{leaderboard_id}` giver rækkerne.
- I et holdleaderboard er feltet `player` **holdet**, og `user_id` dets id.

**Udvælgelsen sker på status og datoer, ikke på navne.** Første version ledte
efter mønsteret `ESEA League EU Advanced S55 Qualifier` og fandt kun 59 af de
543 — 460 har slet ingen sæson i navnet, og den sæson der faktisk kørte var
ikke blandt dem. Botten svarede derfor om S55 længe efter den var slut.

**Den kørende sæson findes gennem spillerens kampe.** Det lyder omvejet, og
det er det, men det er den eneste officielle kilde. Målt:

- Organizerens championships: 542 turneringer, **ingen igangværende** — heller
  ikke med `type=ongoing` eller `type=upcoming`
- `/teams/{id}/tournaments`: **nul**
- `/teams/{id}/championships` og `/leagues`: **404**

Men hver FACEIT-kamp hører til en turnering, og en spiller der er aktiv i
ligaen bærer den i sin historik. `!esea` henter derfor spillerens seneste
kampe, tager de turneringer der er af typen `championship`, og leder efter
holdet i deres stillinger. Findes holdet ikke der, falder den tilbage til
organizerens historik, og svaret mærkes `afsluttet`.

**Navnene matches ikke på en fast rækkefølge.** ESEA navngiver ikke
konsekvent — historikken hedder `ESEA League EU Advanced S55 Qualifier`, den
kørende sæson `S59 EU Main B - Regular Season`. Sæson, region og division
findes hver for sig, hvor de end står, og det der mangler bliver null. Et
strikt mønster var netop grunden til at den kørende sæson aldrig blev
genkendt.

FACEIT's interne web-API blev prøvet og forkastet: alle seks kandidatruter
svarede 404, og den officielle vej virker.

**Placeringen er udledt, ikke læst.** API'ets `position` er 0 på hver eneste
række, også på føreren med flest point, så stillingen sorteres selv og
placeringen tælles derfra: point, så sejre, så sejre minus nederlag, og
holdnavn til sidst for en stabil rækkefølge.

Derfor kan tallet **afvige fra ESEA's egen side** for hold med lige mange
point. Deres skillelinje er formentlig rundeforskel eller indbyrdes opgør, og
ingen af delene er i svaret. Med 76 hold i en division ligger mange på samme
pointtal, så forskellen er ikke teoretisk.

Sæsonerne i API'et går til S55, og de er alle afsluttede. Season 59 var åben
for tilmelding på FACEIT's hjemmeside, men findes ikke i API'et endnu, så
`!esea` rapporterer den seneste sæson der har data.

## Admin-kommandoer

Alt der styrer kanalens opsætning har præfikset `!csbot`, og er lukket for
almindelige seere. Præfikset holder dem adskilt fra seernes kommandoer og fra
andre bots i samme chat; det kan skiftes med `ADMIN_PREFIX` i `.env`.

| Kommando | Hvem | Virkning |
|---|---|---|
| `!csbotcommands` | alle | Linker hertil |
| `!csbotplayerlist` | mod | Viser kanalens region, land og spillerliste |
| `!csbotaddplayer <nick>` | mod | Tilføjer, efter at kontoen er slået op hos FACEIT |
| `!csbotremoveplayer <nick>` | mod | Fjerner fra listen |
| `!csbotaddmain <nick>` | mod | Sætter main, og tilføjer til listen hvis den mangler |
| `!csbotremovemain <nick>` | mod | Fjerner main |
| `!csbotregion EU` | mod | Sætter kanalens region — `EU`, `NA`, `SA`, `AS`, `OCE` |
| `!csbotcountry dk` | mod | Sætter landet `!top` måler mod |
| `!csbotesea` | mod | Diagnose: hvad botten ser hos ESEA, og hvor den leder |
| `!csbotesea <hold eller nick>` | mod | Prøver holdets ruter, eller viser turneringerne bag en spillers seneste kampe |

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

Botten skriver levelet som et almindeligt ord — `LVL10` — og 7TV bytter det
ud med et ikon hos dem der har udvidelsen installeret. Navnene skal være
præcis disse, med store bogstaver — 7TV skelner:

```
LVL1  LVL2  LVL3  LVL4  LVL5  LVL6  LVL7  LVL8  LVL9  LVL10
```

Mangler én af dem, skriver botten bare navnet som tekst på den linje. Uden
udvidelsen ser seerne `LVL10 2347 elo` som ren tekst, hvilket stadig læses
fint. Vil du helt undgå ikonerne, sættes `RANK_STYLE=letters`, og så skriver
botten `L10 2347elo`.

Bruger dit sæt et andet præfiks, sættes `RANK_EMOTE_PREFIX` i `.env` — fx
`LEVEL` for `LEVEL1 … LEVEL10`. Navnet er en egenskab ved emote-sættet, ikke
ved botten, så det hører hjemme i konfigurationen.

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

## Token-fornyelse

Et Twitch-token udløber efter omkring 60 dage. Uden fornyelse stopper botten en
tilfældig dag med `Login authentication failed` — og det sker mens ingen kigger.

Sæt `TWITCH_REFRESH_TOKEN` i `.env` (den fås sammen med access token fra
token-generatoren), så fornyer botten selv: ved opstart, og hver sjette time
mens den kører. Fornyede tokens gemmes i `data/twitch-tokens.json`, så de
overlever en genstart.

Sætter du også `TWITCH_CLIENT_ID` og `TWITCH_CLIENT_SECRET` fra en app du selv
opretter på [dev.twitch.tv](https://dev.twitch.tv/console/apps), fornyes der
hos Twitch direkte. Uden et secret går fornyelsen gennem
twitchtokengenerator.com, hvilket virker, men binder botten til at den side
bliver ved med at findes.

Skriver du et nyt token i `.env` i hånden, vinder det over det gemte —
sammenligningen sker på refresh-tokenet, så en manuel udskiftning ikke bliver
overskrevet af en forældet kopi.

To detaljer der er lette at tage fejl af, og som begge er dækket af tests:

- **Twitch udsteder en ny refresh token ved hver fornyelse**, og den gamle
  holder op med at virke. Tabes den, er kæden brudt for altid.
- **Et netværksudfald er ikke et dødt token.** Kan Twitch ikke nås, fornyes der
  ikke — ellers ville en forbigående fejl brænde refresh-tokenet af.

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

Og `logs/boot.log` skrives af `index.js` i roden, før noget andet indlæses.
Den findes fordi alt hvad der kan gå galt ved opstart går galt *før* loggeren
er indlæst — den første ikke-indbyggede import er `tmi.js`, og mangler den,
kaster Node med det samme. På et panel hvor konsollen er upålidelig efterlader
det ellers nul spor, kun en container der standser. `boot.log` siger hvad der
fejlede, og peger på den sandsynlige udvej.

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
