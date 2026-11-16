// The comments panel on the left, as in ONLYOFFICE: the document's comments (author, date, the
// commented text, edit and resolve) and its tracked changes (accept or reject each). Clicking an
// entry selects its text. The panel follows edits; the comment under the cursor is highlighted.
import { h, iconButton, ask, background } from "./shared/page.js";
import { icon } from "./shared/icons.js";

const when = (date) => {
  const d = date ? new Date(date) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
};
const short = (text, n = 90) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function createReviewPanel({ mount, getEditor, getDocName, onChange, onClose, authorHue }) {
  const panel = h("aside.rp", { hidden: true, "aria-label": "Comments and changes" });
  mount.append(panel);
  let open = false;
  let queued = false;

  const avatar = (author) => h("span.rp-avatar", { style: { "--chg-hue": String(authorHue(author)) } }, (author || "?").trim().charAt(0).toUpperCase());

  function draw() {
    queued = false;
    const editor = getEditor();
    panel.hidden = !open || !editor;
    if (panel.hidden) return;
    const comments = editor.comments();
    const changes = editor.changes();
    const { from } = editor.view.state.selection;
    const active = comments.find((c) => from >= c.from && from <= c.to)?.id;
    for (const el of editor.view.dom.querySelectorAll(".wr-comment.active")) el.classList.remove("active");
    if (active) for (const el of editor.view.dom.querySelectorAll(`.wr-comment[data-comment-id="${CSS.escape(active)}"]`)) el.classList.add("active");

    const select = (item) => { editor.selectRange(item.from, item.to); editor.view.domAtPos(item.from).node?.parentElement?.scrollIntoView({ block: "center" }); editor.focus(); };
    const commentCards = comments.map((c) => h(`div.rp-card${c.id === active ? ".active" : ""}`, { onclick: (e) => { if (!e.target.closest("button")) select(c); } },
      h("div.rp-head", {}, avatar(c.author), h("div.rp-who", {}, h("strong", {}, c.author || "Comment"), h("span", {}, when(c.date)))),
      h("div.rp-quote", {}, short(c.quote, 80)),
      h("div.rp-text", {}, c.text),
      h("div.rp-actions", {},
        iconButton("forum", "Discuss in chat", () => background("chat-draft", { text: `About this comment in ${getDocName()} (${c.author || "someone"}): “${c.text}”\n\nOn the text: “${c.quote}”\n\n` }), { small: true }),
        iconButton("edit", "Edit the comment", async () => {
          const text = await ask({ title: "Edit comment", value: c.text, ok: "Save" });
          if (text !== null) { editor.updateComment(c.id, text); onChange(); }
        }, { small: true }),
        iconButton("check", "Resolve (remove the comment; the text stays)", () => { editor.updateComment(c.id, null); onChange(); }, { small: true }))));
    const changeCards = changes.map((c) => h("div.rp-card.rp-change", { onclick: (e) => { if (!e.target.closest("button")) select(c); } },
      h("div.rp-head", {}, avatar(c.author), h("div.rp-who", {}, h("strong", {}, c.author || "Someone"), h("span", {}, when(c.date)))),
      h("div.rp-text", {}, h("span.rp-kind", {}, c.kind === "insertion" ? "Inserted " : "Deleted "), h(c.kind === "insertion" ? "ins" : "del", { style: { "--chg-hue": String(authorHue(c.author)) } }, short(c.text.trim() ? c.text : "(a space)", 120))),
      h("div.rp-actions", {},
        iconButton("check", "Accept this change", () => { editor.resolveChanges(true, c); onChange(); }, { small: true }),
        iconButton("close", "Reject this change", () => { editor.resolveChanges(false, c); onChange(); }, { small: true }))));
    panel.replaceChildren(
      h("div.wp-panel-head", {}, "Comments", h("span.spacer"), h("button", { type: "button", title: "Close", onclick: () => { open = false; draw(); onClose?.(); } }, icon("w-close", { size: 18 }))),
      h("div.rp-section", {}, h("h2", {}, icon("comment", { size: 16 }), `Comments (${comments.length})`)),
      ...(comments.length ? commentCards : [h("p.rp-empty", {}, "No comments. Select text and choose Collaboration → Add Comment (Ctrl+Alt+M).")]),
      h("div.rp-section", {}, h("h2", {}, icon("track_changes", { size: 16 }), `Changes (${changes.length})`),
        changes.length ? h("span.rp-all", {},
          h("button.btn.small", { type: "button", onclick: () => { editor.resolveChanges(true); onChange(); } }, "Accept all"),
          h("button.btn.small", { type: "button", onclick: () => { editor.resolveChanges(false); onChange(); } }, "Reject all")) : null),
      ...(changes.length ? changeCards : [h("p.rp-empty", {}, "No tracked changes. Turn on Collaboration → Track Changes to record edits.")]),
    );
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  return {
    get open() { return open; },
    set(value) { open = Boolean(value); draw(); },
    schedule,
  };
}
