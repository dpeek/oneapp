import { documentTypography } from "@orumai/ui";
import type { HtmlBuilder } from "foldkit/html";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { taskImageId } from "./task-image-markdown.ts";
import type { Task } from "./tasks-contract.ts";

export const taskDescriptionView = <Message>(
  task: Pick<Task, "id" | "description">,
  h: HtmlBuilder<Message>,
) => {
  if (!task.description.trim()) return h.empty;

  const template = document.createElement("template");
  template.innerHTML = micromark(task.description, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });

  for (const image of template.content.querySelectorAll("img")) {
    // Task descriptions only load images uploaded to the current task.
    if (!taskImageId(task.id, image.getAttribute("src") ?? "")) {
      image.replaceWith(image.alt);
      continue;
    }
    image.loading = "lazy";
  }
  // Micromark emits an empty destination for blocked URLs.
  for (const link of template.content.querySelectorAll('a[href=""]'))
    link.removeAttribute("href");

  for (const [tag, className] of Object.entries(documentTypography.heading)) {
    for (const heading of template.content.querySelectorAll(tag))
      heading.className = className;
  }
  for (const quote of template.content.querySelectorAll("blockquote"))
    quote.className = documentTypography.quote;
  for (const block of template.content.querySelectorAll("pre"))
    block.className = `task-description-code ${documentTypography.codeBlock}`;
  for (const code of template.content.querySelectorAll("code:not(pre code)"))
    code.className = documentTypography.inlineCode;

  return h.div(
    [
      h.Class(
        `task-description-body task-description-rendered ${documentTypography.body}`,
      ),
      h.InnerHTML(template.innerHTML),
    ],
    [],
  );
};
