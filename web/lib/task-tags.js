const TASK_TAG = /(^|[\s([{])#([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w#/-])/g;
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_MAX = 40;

export function isTaskId(id) {
  return typeof id === "string" && id.length <= ID_MAX && TASK_ID.test(id);
}

export function taskTags(text) {
  return [...text.matchAll(TASK_TAG)].filter(match => isTaskId(match[2]));
}

export function taskLink(project, task) {
  return "#" + new URLSearchParams({ project, level: "tasks", task });
}

export function remarkTaskLinks({ project, ids }) {
  function linkify(node) {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap(child => {
      if (child.type !== "text") { linkify(child); return [child]; }
      const links = taskTags(child.value).filter(match => ids.has(match[2]));
      if (!links.length) return [child];
      const parts = [];
      let offset = 0;
      for (const match of links) {
        const start = match.index + match[1].length;
        const id = match[2];
        if (start > offset) parts.push({ type: "text", value: child.value.slice(offset, start) });
        parts.push({ type: "link", url: taskLink(project, id), children: [{ type: "text", value: "#" + id }] });
        offset = start + id.length + 1;
      }
      if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) });
      return parts;
    });
  }
  return linkify;
}
