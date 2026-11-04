/**
 * Indgang i roden.
 *
 * Node-værter kører som standard `index.js` i projektroden — Pterodactyl og
 * Pelican har det som standardværdi i deres Node-egg. Botten selv ligger i
 * src/, og at skulle huske at rette den indstilling er netop den slags detalje
 * der koster en halv time på en server hvor den eneste fejlmeddelelse er at
 * der ingenting sker.
 *
 * Derfor denne. Både `node index.js` og `node src/index.js` virker nu.
 */
import { main, runFatal } from './src/index.js';

main().catch(runFatal);
