// Datenauszug Europa sofort herunterladen bzw. aktualisieren: npm run extract:update
// (Der laufende Server macht das sonst selbst – kurz nach dem Start und danach alle 12 Stunden.
// Ein laufender Server liest den neuen Stand beim nächsten Neustart ein.)
import './env.mjs';
import { updateExtract } from './extract.mjs';

await updateExtract(msg => console.log(msg));
