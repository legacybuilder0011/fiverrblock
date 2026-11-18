"use strict";
// Relaunch a live profile with its exact saved command line + a debug port.
const cp = require("child_process"), fs = require("fs");
const line = fs.readFileSync(process.argv[2], "utf8").replace(/^﻿/, "").trim();
const args = line.match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ""));
const exe = args.shift();
args.splice(args.length - 1, 0, "--remote-debugging-port=9555");
const c = cp.spawn(exe, args, { detached: true, stdio: "ignore" }); c.unref();
console.log("relaunched pid", c.pid, "args", args.length);
