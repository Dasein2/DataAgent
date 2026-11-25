// Recognise SQL fences only. Ordinary prose and its important caveats always stay visible.
const sqlLanguages = new Set(["sql", "mysql", "postgres", "postgresql", "sqlite", "doris", "starrocks", "hive", "spark"]);
export function splitAnswerEvidence(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const prose = [], sql = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/.exec(lines[i]);
    if (!open) { prose.push(lines[i]); continue; }
    const block = [lines[i]], code = [], lang = open[2].trim().toLowerCase().split(/\s+/)[0];
    const close = new RegExp("^ {0,3}" + open[1][0] + "{" + open[1].length + ",}\\s*$");
    for (i++; i < lines.length; i++) {
      block.push(lines[i]);
      if (close.test(lines[i])) break;
      code.push(lines[i]);
    }
    const isSql = sqlLanguages.has(lang) || (!lang && /^\s*(select|with|show|describe|desc|explain)\b/i.test(code.join("\n")));
    (isSql ? sql : prose).push(block.join("\n"));
  }
  return { answer: prose.join("\n").trim(), sql };
}

/** No model HTML is trusted; renderMarkdown must escape its inputs. Original text remains copyable. */
export function renderAnswer(node, source, { renderMarkdown, status = "succeeded" }) {
  const parts = splitAnswerEvidence(source);
  node.replaceChildren();
  node.className = "text final";
  if (status !== "succeeded") {
    const label = document.createElement("p"); label.className = "answer-partial";
    label.textContent = "未完成的分析 · 以下内容可能不完整"; node.append(label);
  }
  if (parts.answer) {
    const prose = document.createElement("div"); prose.className = "answer-prose";
    prose.innerHTML = renderMarkdown(parts.answer); node.append(prose);
  }
  if (parts.sql.length) {
    const details = document.createElement("details"); details.className = "answer-sql";
    const summary = document.createElement("summary"); summary.textContent = "查看 SQL 依据";
    const content = document.createElement("div"); content.innerHTML = renderMarkdown(parts.sql.join("\n\n"));
    details.append(summary, content); node.append(details);
  }
  return node;
}

export function attachResultEvidence(host, resultIds, openResult) {
  if (!resultIds?.length || host.querySelector(".task-result-evidence")) return;
  const details = document.createElement("details"); details.className = "task-result-evidence";
  const summary = document.createElement("summary"); summary.textContent = "查看数据依据 · " + new Set(resultIds).size + " 份结果";
  details.append(summary);
  const note = document.createElement("p"); note.textContent = "查看已保存的数据、原始 SQL 和执行时间；执行时间不等于数据更新时间。";
  details.append(note);
  [...new Set(resultIds)].forEach((id, index) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "ghost";
    button.textContent = "结果 " + (index + 1); button.title = id;
    button.onclick = () => openResult(id); details.append(button);
  });
  host.append(details);
}
