import express from "express";
import cors from "cors";
import { Bot } from "./bot/browser.js";
import compression from "compression";
const app = express();
app.use(cors({ origin: "" }));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.set("view engine", "ejs");
app.use("/public", express.static("public"));
app.get("/", async (req, res) => {
  res.render("index", {});
});
app.post("/:url", async (req, res) => {
  try {
    if (!req.params.url) throw Error("Url no definida");
    const bot = new Bot();
    await bot.startBrowser();
    await bot.setPage(atob(req.params.url));
    const route = await bot.takeScreenshot();
    await bot.closeBrowser();
    // console.log(route);
    res.json({ status: true, content: route });
  } catch (error) {
    res.json({ status: false });
  }
});

app.listen(3001, async () => {
  console.log("listen to 3001");
});
