// The session list's Dead fold: dead cards leave Offline into their own section, behind one tap.
// Pure, so Home and Sessions and their tests share exactly the grouping the cards render.
import { isDead } from "./session-state.js";

/** [offline cards that are not dead, dead cards], both in the tree's order; children were judged with their parent. */
export function deadSplit(tree, now) {
  const offline = tree.filter(node => node.group === "offline");
  const dead = offline.filter(node => isDead(node, now));
  const deadIds = new Set(dead.map(node => node.project + node.id));
  return [offline.filter(node => !deadIds.has(node.project + node.id)), dead];
}
