const http = require("node:http");
const { handle } = require("./src/routes.js");

http.createServer(handle).listen(Number(process.env.PORT || 3000));
