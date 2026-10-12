#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { loadConfig } from "./lib/config.js";
import { addNote, listNotes, parseArguments } from "./lib/notes.js";

const config = loadConfig(process.env);
const command = parseArguments(process.argv.slice(2));
const store = await readFile(config.storePath, "utf8").catch(() => "[]");
let notes = JSON.parse(store);

if (command.name === "add") {
  notes = addNote(notes, command.text);
  await writeFile(config.storePath, JSON.stringify(notes, null, 2));
} else if (command.name === "list") {
  process.stdout.write(listNotes(notes).join("\n") + "\n");
} else if (command.name === "serve") {
  const server = createServer((request, response) => {
    if (request.url === "/api/notes") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ notes, sync_endpoint: config.syncEndpoint }),
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  server.listen(config.port, "127.0.0.1");
}
