// `npm run build && npm run dev:demo`: the real app on :8585 with a fake
// Ollama and a fake mailbox full of sample mail, so every page can be tried
// without a PC running a model or a real email account. Data is kept in
// ./data/demo.db; delete it to start over. Point Settings → Local AI at the
// address printed below, and add any email account (the details are ignored).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../server/db.ts";
import { buildApp } from "../server/app.ts";
import { FakeMailbox, startFakeCarrel, startFakeMicrosoft, startFakeOllama, startIcsServer } from "./fakes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ollama = await startFakeOllama(11500);
const mail = new FakeMailbox();
const hours = (h: number) => new Date(Date.now() - h * 3_600_000);
const soon = (d: number) => new Date(Date.now() + d * 86_400_000).toLocaleDateString("en-CA");
mail.deliver({ fromAddr: "billing@citypower.example", fromName: "City Power & Light", subject: "Your bill is ready: payment due", text: `Your November statement is ready. Amount due: $84.12, due ${soon(9)}.`, bulk: true, date: hours(2) });
mail.deliver({ fromAddr: "lee@wabash.example", fromName: "Prof. Dana Lee", subject: "Lab moved to Thursday", text: "Hi all, this week's lab is moving to Thursday at 2pm in Hays 104. Bring your notebooks.", date: hours(5) });
mail.deliver({ fromAddr: "deals@reptilesupply.example", fromName: "Reptile Supply Co.", subject: "Black Friday: 30% off all terrariums", text: "Shop now and save big on everything.", bulk: true, date: hours(7) });
mail.deliver({ fromAddr: "no-reply@shipping.example", fromName: "ParcelTrack", subject: "Your package has shipped", text: "Your order of 500 fruit flies has shipped and will arrive Thursday.", date: hours(9) });
mail.deliver({ fromAddr: "prize-dept@winner.example", subject: "You've won a $1000 gift card!!!", text: "Claim your prize now, just send your bank details.", date: hours(12) });
mail.deliver({ fromAddr: "office@sunsetvet.example", fromName: "Sunset Exotic Vet", subject: "Please confirm Pickles' checkup", text: `Please confirm your gecko Pickles' annual checkup on ${soon(4)} at 10:30am by replying to this email.`, date: hours(20) });
mail.deliver({ fromAddr: "newsletter@frognerd.example", fromName: "Frog Nerd Weekly", subject: "Issue #212: misting schedules", text: "This week: how often to mist your vivarium.", bulk: true, date: hours(26) });

mail.send({ to: [{ name: "Prof. Dana Lee", addr: "lee@wabash.example" }], subject: "Extension on lab 4?", text: "Hi Professor Lee, could I have until Friday to hand in lab 4? I was sick on Monday.\n\nThanks,\nOwen", date: hours(30) });
mail.send({ to: [{ name: "Sunset Exotic Vet", addr: "office@sunsetvet.example" }], subject: "Calcium dust for Pickles", text: "Hi, how often should I dust Pickles' crickets with calcium? Thanks!", date: hours(24 * 4) });
mail.send({ to: [{ name: "Sam", addr: "sam@example.com" }], subject: "Re: bio notes", text: "Got them, thanks!", date: hours(8) });

// A calendar with a class today and a dentist appointment, and a carrel with some school work.
const iso = (d: number, h: number, m = 0) => {
  const x = new Date();
  x.setDate(x.getDate() + d);
  x.setHours(h, m, 0, 0);
  return x;
};
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ics = await startIcsServer(
  () => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//demo//EN
BEGIN:VEVENT\nUID:bio\nSUMMARY:BIO 111 lecture\nLOCATION:Hays 104\nDTSTART:${icsTime(iso(-7, 10))}\nDTEND:${icsTime(iso(-7, 10, 50))}\nRRULE:FREQ=DAILY;COUNT=40\nEND:VEVENT
BEGIN:VEVENT\nUID:dentist\nSUMMARY:Dentist\nLOCATION:Crawfordsville Family Dental\nDTSTART:${icsTime(iso(0, 15, 30))}\nDTEND:${icsTime(iso(0, 16, 30))}\nEND:VEVENT
END:VCALENDAR`,
  11501,
);
const carrel = await startFakeCarrel(
  {
    email: "demo@example.com",
    password: "fake-demo-pass",
    tasks: [
      { id: "t1", title: "Lab report 4", due_at: iso(1, 23, 59).toISOString(), course: "BIO 111" },
      { id: "t2", title: "Problem set 7", due_at: iso(-1, 12).toISOString(), course: "MAT 223" },
    ],
    readings: [{ id: "r1", title: "Campbell ch. 9", pages: "160-185", due_date: soon(0), course: "BIO 111" }],
    exams: [{ id: "e1", title: "Midterm 2", exam_at: iso(5, 9).toISOString(), course: "BIO 111" }],
  },
  11502,
);

// "Sign in with Microsoft" against a fake: client id 11111111-2222-3333-4444-555555555555,
// and the sign-in "completes" a few seconds after the code is shown.
const microsoft = await startFakeMicrosoft(11503);
microsoft.pendingPolls = 4;

const db = openDb(path.resolve(here, "../data/demo.db"));
const { app, engine } = await buildApp({ db, version: "demo", repo: "OwenWright8/docket", updateCheck: false, mail, microsoftBase: microsoft.url, webRoot: path.resolve(here, "../dist/web") });
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT || 8585) });
engine.start();
console.log(`[demo] Docket on http://localhost:${process.env.PORT || 8585}`);
console.log(`[demo] fake Ollama on ${ollama.url} (models llama3.1:8b, qwen2.5:7b)`);
console.log(`[demo] calendar link ${ics.url}; carrel at ${carrel.url} (demo@example.com / fake-demo-pass)`);
