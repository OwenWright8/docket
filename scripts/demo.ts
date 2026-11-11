// `npm run build && npm run dev:demo`: the real app on :8585 with a fake
// Ollama and a fake mailbox full of sample mail, so every page can be tried
// without a PC running a model or a real email account. Data is kept in
// ./data/demo.db; delete it to start over. Point Settings → Local AI at the
// address printed below, and add any email account (the details are ignored).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../server/db.ts";
import { buildApp } from "../server/app.ts";
import { FakeMailbox, startFakeOllama } from "./fakes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ollama = await startFakeOllama(11500);
const mail = new FakeMailbox();
const hours = (h: number) => new Date(Date.now() - h * 3_600_000);
const soon = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
mail.deliver({ fromAddr: "billing@citypower.example", fromName: "City Power & Light", subject: "Your bill is ready: payment due", text: `Your November statement is ready. Amount due: $84.12, due ${soon(9)}.`, bulk: true, date: hours(2) });
mail.deliver({ fromAddr: "lee@wabash.example", fromName: "Prof. Dana Lee", subject: "Lab moved to Thursday", text: "Hi all, this week's lab is moving to Thursday at 2pm in Hays 104. Bring your notebooks.", date: hours(5) });
mail.deliver({ fromAddr: "deals@reptilesupply.example", fromName: "Reptile Supply Co.", subject: "Black Friday: 30% off all terrariums", text: "Shop now and save big on everything.", bulk: true, date: hours(7) });
mail.deliver({ fromAddr: "no-reply@shipping.example", fromName: "ParcelTrack", subject: "Your package has shipped", text: "Your order of 500 fruit flies has shipped and will arrive Thursday.", date: hours(9) });
mail.deliver({ fromAddr: "prize-dept@winner.example", subject: "You've won a $1000 gift card!!!", text: "Claim your prize now, just send your bank details.", date: hours(12) });
mail.deliver({ fromAddr: "office@sunsetvet.example", fromName: "Sunset Exotic Vet", subject: "Please confirm Pickles' checkup", text: `Please confirm your gecko Pickles' annual checkup on ${soon(4)} at 10:30am by replying to this email.`, date: hours(20) });
mail.deliver({ fromAddr: "newsletter@frognerd.example", fromName: "Frog Nerd Weekly", subject: "Issue #212: misting schedules", text: "This week: how often to mist your vivarium.", bulk: true, date: hours(26) });

const db = openDb(path.resolve(here, "../data/demo.db"));
const { app, engine } = await buildApp({ db, version: "demo", repo: "OwenWright8/docket", updateCheck: false, mail, webRoot: path.resolve(here, "../dist/web") });
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT || 8585) });
engine.start();
console.log(`[demo] Docket on http://localhost:${process.env.PORT || 8585}`);
console.log(`[demo] fake Ollama on ${ollama.url} (models llama3.1:8b, qwen2.5:7b)`);
