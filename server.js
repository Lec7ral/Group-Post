import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

app.get("/", (_req, res) => {
  res.redirect("/app/");
});

app.use(express.static(__dirname));

app.listen(PORT, HOST, () => {
  console.log(`Group Poster preview server listening on http://${HOST}:${PORT}`);
});
