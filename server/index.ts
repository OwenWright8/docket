// Entry point. Everything is configured in the web UI; the environment only
// holds deployment details, all optional:
//   PORT          port to listen on inside the container (default 8585)
//   DATA_DIR      where the database lives (default /data, or ./data outside Docker)
//   UPDATE_CHECK  "off" stops the check for new releases
//   TZ            your time zone: reminders, "today" and the summary time use it
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8585);
const dataDir = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.resolve(here, "../data"));
const version = process.env.DOCKET_BUILD_VERSION || "dev";
const repo = process.env.DOCKET_REPO || "OwenWright8/docket";
const updateCheck = !/^(off|false|0|no)$/i.test(process.env.UPDATE_CHECK ?? "on");

const db = openDb(path.join(dataDir, "docket.db"));
const { app, engine, updates } = await buildApp({ db, version, repo, updateCheck, webRoot: path.resolve(here, "../dist/web") });

await app.listen({ host: "0.0.0.0", port });
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(`[docket] ${version} listening on :${port} (data in ${dataDir}, time zone ${tz})`);
if (tz === "UTC" && !process.env.TZ) console.log("[docket] tip: set TZ (e.g. America/Indiana/Indianapolis) so reminders go out at your local time");
engine.start();
updates.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    engine.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
