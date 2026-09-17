import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";

// Exercita a apresentação sem depender da WebView nativa nem de um servidor real.
const source = await readFile(new URL("../src/PlayerRoster.tsx", import.meta.url), "utf8");
const { code } = await transformWithEsbuild(source, "PlayerRoster.tsx", {
  loader: "tsx", format: "cjs", jsx: "transform",
  jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
});
const module = { exports: {} };
new Function("module", "exports", "React", code)(module, module.exports, React);
const render = (players) => renderToStaticMarkup(React.createElement(module.exports.PlayerRoster, { players }));
assert.match(render(null), /indisponível/);
assert.match(render({ online: 0, max: 20 }), /Nenhum jogador conectado/);
assert.match(render({ online: 2, max: 20 }), /não disponibilizou os nomes/);
assert.match(render({ online: 2, max: 20, names: ["Edu_PDX"], names_complete: false }), /Lista parcial: 1 de 2/);
const complete = render({ online: 1, max: 20, names: ["Edu_PDX"], names_complete: true });
assert.match(complete, /Edu_PDX/);
assert.doesNotMatch(complete, /Lista parcial/);
assert.doesNotMatch(render({ online: 1, max: 20, names: ["<script>alert(1)</script>"] }), /<script>/);
console.log("6 cenários da lista de jogadores passaram.");
