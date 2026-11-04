# CS-Bot — design

Twitch-chatbot der viser Counter-Strike 2-rangdata, bygget som pendant til
[LoL Twitch Bot](https://github.com/Petsen02/TwitchBot).

Dette er en plan, ikke en implementering. Den skal godkendes før der kodes.

> **Ansvarsfraskrivelse (udkast)**
>
> CS-Bot is not endorsed by Valve Corporation or FACEIT and does not reflect
> the views or opinions of either. Counter-Strike and all associated
> properties are trademarks or registered trademarks of Valve Corporation.

> **Opdateret efter planen blev skrevet:** omfanget er nu **FACEIT og ESEA**.
> Valve's Premier er ude, som et valg frem for som en mangel. ESEA er tilføjet
> og kan hentes gennem FACEIT's egne league-endpoints, fordi ESEA drives af
> ESL FACEIT Group og ligaen ligger på FACEIT's platform. Se §13.

## 1. Den hårde begrænsning: ingen officiel Premier-API

Valve udstiller ikke Premier CS Rating nogen steder. Steam Web API giver
profil, ejede spil, spilletid og achievements — men hverken CS Rating eller
skill group. De projekter der alligevel læser Premier-rating, snakker direkte
med Valves Game Coordinator via en lokal spilklient. Det er uofficielt, kræver
en kørende CS-installation, og går i stykker uden varsel.

Der findes altså ingen Riot-agtig "hent en nøgle og spørg"-vej til Premier.

**Derfor bygges botten på FACEIT**, som har en officiel, dokumenteret API med
rigtige nøgler. Konsekvensen er, at botten rapporterer FACEIT-elo og -level —
ikke det tal folk ser i selve spillet. Det skal stå tydeligt i README, så
ingen streamer bliver overrasket.

Premier kan tilføjes senere bag samme kommandoer, hvis en uofficiel kilde
(Leetify, csstats.gg) viser sig stabil nok. Designet herunder lukker ikke den
dør, men regner ikke med den.

## 2. Modulkort

Tallene i parentes er linjer i LoL-botten.

### Genbruges uændret eller nær uændret (~1.100 linjer)

| Fil | Ændring |
|---|---|
| `cache.js` (70) | Ingen. Spilagnostisk TTL/LRU-cache |
| `limiter.js` (63) | Ingen. Kun andre vinduer i konfigurationen |
| `logger.js` (170) | Ingen |
| `time.js` (94) | Ingen |
| `store.js` (178) | Strukturen holder: atomic write, snapshot, matches, baselines, prune. `puuid` → `player_id`, `cutoffs` → `challenger` |
| `channels.js` (156) | Strukturen holder: per-kanal roster, main, dedup af trackede konti. `Navn#TAG` → FACEIT-nick, `platform` → `region` |
| `index.js` (216) | ~90%: tmi.js, kommandotabel, cooldown, mod/broadcaster-rettigheder. Kun `explain()` og kommandolisten skifter |
| `config.js` (194) | .env-loaderen og valideringshjælperne (`seconds`, `count`, `required`) uændret. Regions- og nøglefelter skifter |
| `tracker.js` (138) | Mønsteret holder helt: adaptiv polling, snapshot → delta, dagsbaseline. Kun API-kaldene skifter |
| `deploy/*.service` | Uændret, nyt navn |

### Skrives om (~1.500 linjer)

| Fil | Bliver til |
|---|---|
| `riot.js` (220) | `faceit.js` — samme form: fejlklasse, `describe(status)`, retry, limiter pr. region, cache pr. emne |
| `ladder.js` (175) | `elo.js` — meget enklere. CS2 har ingen tier/division-matematik, bare ét tal og 10 faste level-grænser |
| `cutoffs.js` (117) | Udgår. `!top` slår placeringen op direkte, så der er intet at planlægge og cache på klokkeslæt |
| `champions.js` (50) | `maps.js` — statisk liste (Mirage, Inferno, Nuke, Ancient, Dust2, Train, Anubis). Intet Data Dragon, intet preload |
| `lolpros.js` (75) | Udskydes. HLTV har ingen officiel API. `!lobby` viser kun gennemsnitselo i v1 |
| `commands.js` (474) | Omskrives pr. kommando, samme struktur |
| `format.js` (192) | Omskrives. `SEP = ' │ '` og tonen beholdes |

## 3. Kommando-oversættelse

| LoL | CS | Svar (udkast) |
|---|---|---|
| `!rank` | `!rank [nick]` | `PETSEN LEVEL10: 2347 ELO` — Challenger-spillere får også `(Rank#412)` |
| `!ranks` | `!ranks` | Kanalens liste, nummereret, højeste elo først |
| `!gains` / `!session` | samme | `PETSEN: 3W 2L (+47 elo) 🟩🟩🟥🟩🟥` for i dag |
| `!nextrank` | `!nextrank [nick]` | `PETSEN LEVEL9: 1920 elo │ mangler 81 elo til LEVEL10` |
| `!lastgame` | `!lastgame [nick]` | `PETSEN │ Mirage 13-9 W │ 24-17-6 │ 1.41 K/D │ 94.2 ADR │ 48% HS` |
| `!lobby` | `!lobby [nick]` | Gennemsnitselo i igangværende kamp, pr. hold |
| `!chal` / `!cutoff` | `!top` | `PETSEN LEVEL10: 2347 elo │ DK #12 │ EU #418` — land og region, ikke cutoffs |
| — | `!maps [nick]` | Ny: bedste og dårligste map efter winrate. FACEIT giver segmenter pr. map gratis |
| — | `!esea [nick]` | Ny: `PETSEN │ ESEA Advanced Group C │ Nordic Noobs 7-3 │ #4`. Holdliga, ikke personlig stige |

Admin-kommandoerne beholder `!old`-præfikset, så muskelhukommelsen virker på
tværs af de to bots:

`!oldcommands` · `!oldplayerlist` · `!oldaddplayer` · `!oldremoveplayer` ·
`!oldaddmain` · `!oldremovemain` · `!oldregion`

## 4. Datakilde: FACEIT Data API v4

Basis `https://open.faceit.com/data/v4`, header `Authorization: Bearer <nøgle>`.
Nøgle oprettes i FACEITs Developer Portal (App Studio).

| Behov | Endpoint |
|---|---|
| Opslag på nick | `GET /players?nickname={nick}&game=cs2` |
| Opslag på Steam-ID | `GET /players?game=cs2&game_player_id={steamid64}` |
| Elo + level nu | samme svar: `games.cs2.faceit_elo`, `games.cs2.skill_level` |
| Livstidsstatistik og map-segmenter | `GET /players/{player_id}/stats/cs2` |
| Kamphistorik | `GET /players/{player_id}/history?game=cs2&limit=20` |
| Kampdetaljer, inkl. igangværende | `GET /matches/{match_id}` |
| Kampstatistik | `GET /matches/{match_id}/stats` |
| Placering i region | `GET /rankings/games/cs2/regions/{region}/players/{player_id}` |
| Regions-leaderboard | `GET /leaderboards/games/cs2/regions/{region}` |

**Skal verificeres før kodning.** Jeg kunne ikke åbne `docs.faceit.com` fra
sessionen — netværkspolitikken tillader kun bestemte domæner. Følgende er
derfor husket eller udledt, ikke bekræftet mod dokumentationen:

1. De præcise feltnavne i hvert svar.
2. Om `/matches/{match_id}/stats` har `ADR` for CS2. Hvis ikke, falder
   `!lastgame` tilbage til K/D/HS%.
3. Rate limits. LoL-bottens limiter tager et vilkårligt vindue, så det er kun
   et tal i `.env` — men budgettet skal kendes før pollingintervallerne vælges.
4. Om `/rankings/...` dækker alle spillere eller kun top 1.000.
5. Region-koderne (`EU`, `NA`, `SA`, `AS`, `OCE` — versalerne skal bekræftes).
6. Hvor dybt `/history` kan pagineres. Flere forumtråde beskriver tomme
   `items` ved høje offsets, med `from`/`to`-tidsfiltre som omvej. `!gains`
   spørger kun om i dag, så det bør ikke ramme os.

## 5. Elo → level

Faste grænser, ingen API-opslag. Level 10 har ingen øvre grænse.

| Level | Elo |
|---|---|
| 1 | 100–500 |
| 2 | 501–750 |
| 3 | 751–900 |
| 4 | 901–1 050 |
| 5 | 1 051–1 200 |
| 6 | 1 201–1 350 |
| 7 | 1 351–1 530 |
| 8 | 1 531–1 750 |
| 9 | 1 751–2 000 |
| 10 | 2 001+ |

Grænserne har flyttet sig historisk — ældre guides har level 9 fra 1 851 — så
de lægges i én tabel i `elo.js` med en kommentar om hvor de kommer fra, så en
fremtidig justering er én diff.

Det gør `!nextrank` trivielt sammenlignet med LoL: ingen division-matematik,
ingen "mangler N wins"-gæt. Bare `næste grænse − nuværende elo`. Den målte
gennemsnitlige elo-gevinst pr. sejr fra `store.getAverageLpGain()` kan stadig
bruges til at omsætte det til wins.

## 6. Elo-måling over tid

Samme problem som i LoL-botten: API'et giver nuværende elo, ikke historik.
`/players/{id}/history` dokumenterer ikke elo pr. kamp, så den kan ikke bruges
til at udregne en dags gevinst.

Løsningen er derfor den samme, og `tracker.js` overlever næsten uændret:

1. Snapshot af elo pr. tracket spiller ved hver poll.
2. Ny kamp i historikken → tilskriv ændringen siden sidste snapshot til den kamp.
3. Dagsbaseline med tidsstempel, så en baseline taget midt i en session ikke
   bruges som anker for hele dagen.
4. Adaptiv polling: aktiv 60 s, idle 600 s, aktiv-vindue 45 min.

En CS-kamp er længere end 60 sekunder, så antagelsen om at højst én kamp falder
mellem to målinger holder — ligesom i LoL. Aktiv-vinduet bør måske op fra 45
min, da en FACEIT-kamp kan vare længere end en LoL-kamp.

## 7. Identitet: nick eller Steam-ID

FACEIT-nicks kan ændres; `player_id` er stabil. Samme mønster som LoL-bottens
`riotId` + `puuid`:

- Mods skriver nick i `!oldaddplayer`.
- Botten slår op, gemmer `{ nickname, player_id, steam_id_64 }`.
- Alle senere kald bruger `player_id`.
- Vises nicket fra den gemte post, kan det blive forældet. Tracker-pollen
  opdaterer nicket når den alligevel har svaret i hånden.

`!oldaddplayer` bør også tage et Steam-profillink eller SteamID64, da det er
det streamere oftest har ved hånden. `game_player_id`-opslaget gør det gratis.

## 8. 7TV-ikoner

Samme mekanik: botten skriver level-navnet som et almindeligt ord, 7TV bytter
det til et ikon. Emote-navnene bliver `LEVEL1` … `LEVEL10` (versaler, 7TV
skelner). `RANK_STYLE=letters` giver `L10 2347elo` i stedet.

Et nyt 7TV-sæt skal laves med FACEIT-level-ikoner. Det er en opgave uden for
koden, og botten skal læse fint som ren tekst indtil det findes.

## 9. Konfiguration

```ini
# ---- FACEIT ----
FACEIT_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
FACEIT_REGION=EU
FACEIT_LIMIT_PER_SECOND=         # sættes når budgettet er bekræftet
FACEIT_LIMIT_PER_TEN_MINUTES=

# ---- Twitch ----  (uændret fra LoL-botten)
TWITCH_BOT_USERNAME=
TWITCH_OAUTH_TOKEN=
TWITCH_CHANNELS=

# ---- Seed ----
PLAYERS=
DEFAULT_PLAYER=

# ---- Udseende ----
RANK_STYLE=emotes
CHALLENGER_POSITION_LIMIT=1000

# ---- Timing ----
WIKI_URL=https://github.com/Petsen02/CS-Bot
TIMEZONE=Europe/Copenhagen
CHALLENGER_REFRESH_MINUTES=1440
ACTIVE_POLL_SECONDS=60
IDLE_POLL_SECONDS=600
ACTIVE_WINDOW_MINUTES=60
RANK_CACHE_SECONDS=60
COMMAND_COOLDOWN_SECONDS=5
```

## 10. Eget repo, frisk kode, samme kommandoer

CS-botten er sit eget repo med sin egen kode. Besluttet efter planen blev
skrevet: ikke en port af LoL-botten, men et nyt kodebase der genbruger dens
*mønstre* og dens *kommandonavne*.

Begrundelse: en fælles pakke ville betyde, at en ændring til CS-botten kan
vælte LoL-botten, som kører i produktion. Og en linje-for-linje-kopi ville
trække Riot-specifikke antagelser med sig — tiers, divisioner, to slags
værtsnavne — som intet af har en pendant i CS.

Hvad der faktisk er genbrugt, er mønstrene: atomare skrivninger, TTL/LRU-cache,
kø-baseret rate limiting, adaptiv polling, kommandotabel med rettighedsniveauer.
De er skrevet om til CS frem for kopieret.

Hvad der *er* bevaret ordret, er kommando-vokabularet. `!rank`, `!ranks`,
`!session`, `!nextrank`, `!lastgame`, `!lobby` og hele `!old`-sættet betyder det
samme i begge bots, så muskelhukommelsen virker på tværs. `!chal` er den ene
undtagelse, erstattet af `!top`, fordi FACEIT har ranglister og ikke cutoffs.

Hvis de to bots senere skal dele kode, er `@petsen02/twitch-bot-core` en
separat beslutning, der kan tages uden at røre hverken kommandoer eller
datalag.

## 11. Faser

| Fase | Indhold | Kan testes ved |
|---|---|---|
| 0 | Verificér FACEIT-API'et mod dokumentationen og en rigtig nøgle. Ret §4 og §9 | `npm run check` — smoke test uden Twitch, som LoL-bottens `check.js` |
| 1 | Infrastruktur: kopiér de fire generiske filer, tilpas `config`, `store`, `channels`, `index`. Admin-kommandoer | Botten joiner, `!oldaddplayer` virker |
| 2 | `faceit.js` + `elo.js` + `!rank`, `!ranks`, `!nextrank` | Rigtige tal i chatten |
| 3 | `tracker.js` + `!gains` / `!session` | Elo-delta efter en session |
| 4 | `!lastgame`, `!maps`, `!lobby` | — |
| 5 | `challenger.js` + `!chal` | — |
| 6 | README, 7TV-sæt, systemd-unit | Kører på serveren |

## 12. Åbne spørgsmål

1. **Spiller de FACEIT?** Hele planen falder, hvis de streamere botten skal
   tjene kun spiller Premier. Det er værd at afklare før fase 0.
2. **Hvor mange kanaler og spillere?** Afgør om pollingbudgettet holder.
3. **Skal Premier med senere?** Hvis ja, bør `faceit.js` fra starten ligge bag
   en kildeneutral grænseflade, i stedet for at kommandoerne kalder den direkte.
   Det koster lidt mere nu og meget mindre senere.
4. **`!lobby` uden pro-opslag** — er gennemsnitselo pr. hold nok i v1?

## Kilder

- [Steam Community: CS2 Premier Rating-guide](https://steamcommunity.com/sharedfiles/filedetails/?id=3723613461)
- [Build a CS2 Premier Rating Tracker](https://shattered.io/esports/build-cs2-premier-rating-tracker-2026/)
- [FACEIT Data API-dokumentation](https://docs.faceit.com/docs/data-api/)
- [FACEIT Data API — data-endpoints](https://docs.faceit.com/docs/data-api/data/)
- [FACEIT support: CS2 Elo og skill level](https://support.faceit.com/hc/en-us/articles/10525200579740-FACEIT-CS2-Elo-and-skill-level)
- [FACEIT levels og elo forklaret](https://alviran.net/blog/faceit-levels-elo-explained-cs2-guide/)
- [FACEIT-ranks i CS2, inkl. Challenger-status](https://bo3.gg/articles/faceit-ranks-in-counter-strike-2-everything-you-need-to-know)
- [Forumtråd: paginering i `/players/{id}/history`](https://forums.faceit.com/t/data-api-v4-player-match-history-bug/11089)
- [Leetify public API — docs refereret af community-værktøjer](https://clawhub.ai/leetify)

## 13. ESEA

Tilføjet efter planen blev skrevet, sammen med beslutningen om at droppe
Premier helt.

### Hvorfor gennem FACEIT og ikke play.esea.net

ESEA drives af ESL FACEIT Group, og ESEA League ligger på FACEIT's egen
platform — liga-URL'en er `faceit.com/en/cs2/league/esea league/<league_id>/…`.
Data API v4 har league-endpoints, inklusive en rute for en spillers plads i en
sæson, så ESEA kommer fra samme API, samme nøgle og samme rate limit-budget
som alt andet.

Alternativet var `play.esea.net`, som er Cloudflare-beskyttet. De
community-projekter der henter derfra, kører en headless browser for at komme
igennem. Det ville betyde en Chromium-afhængighed på serveren og et setup der
knækker hver gang Cloudflare strammer skruen — for data vi sandsynligvis kan få
officielt.

### ESEA er en holdliga, og det ændrer svaret

Der findes ikke noget personligt ESEA-tal der svarer til FACEIT-elo. ESEA har
hold, sæsoner og divisioner (Open, Intermediate, Main, Advanced), så `!esea`
svarer om holdet: division, eventuel gruppe, sæsonrekord og placering.

Derfor er det sin egen kommando. At lægge en ESEA-division ind i `!rank` ved
siden af et elo-tal ville sidestille to størrelser der ikke kan sammenlignes.

### Sæsonen udledes, den konfigureres ikke

Sæson-id'et skifter hver sæson. Stod det i `.env`, ville botten vise forældede
tal fra den dag en ny sæson begyndte, indtil nogen huskede at rette det. I
stedet udledes sæsonen af ligaens egen sæsonliste ved hvert opslag:

1. En sæson der er åben nu vinder.
2. Ellers den seneste der er begyndt — så svaret mellem to sæsoner bliver
   "sidste sæson sluttede sådan" frem for ingenting.
3. Rækkefølgen i API-svaret antages ikke, og tidsstempler accepteres som
   sekunder, millisekunder eller ISO.

Kun `ESEA_LEAGUE_ID` står i `.env`, så et skiftet liga-id ikke kræver en
kodeændring.

### Målt: vejen er forkert

Et rigtigt kald afviste antagelsen. `/leagues/{league_id}` svarer **404** på
liga-id'et fra den offentlige ESEA-URL. Enten er det id ikke det Data API'et
kender ligaen under, eller også dækker `/leagues` et andet begreb end ESEA.

`npm run probe-esea` prøver alternativerne af — liga- og championship-stier,
sæson-id'et brugt som liga-id, leaderboards og spillerens plads — og viser hvad
hvert enkelt svarer. Indtil en af dem svarer, er `!esea` ikke funktionsdygtig,
og kommandoen bør ikke slås til i produktion.

Svarer ingen af dem, findes ESEA ikke i Data API'et. Så er valget enten at
droppe `!esea`, eller at hente fra FACEIT's interne web-API, som er
udokumenteret og kan ændre sig uden varsel. Det er en beslutning, ikke en
teknisk detalje, og den bør tages bevidst.
