// The description is all prose between the `# Title` line and the first `## `
// heading, plus the body of any `## Description` section. A lesson with both
// keeps both, in document order, so neither silently replaces the other. Lines
// are trimmed and paragraphs are separated by exactly one blank line.
const toParagraphs = lines => lines.map(line => line.trim()).join('\n')
  .split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(Boolean).join('\n\n');

export function parseLessonPrompt(lessonId, markdown) {
  const lines = markdown.split('\n');
  let name = '';
  const descriptionLines = [];
  let exemplar = '';
  let coachDirective = '';
  const objectives = [];
  let currentSection = null;
  let fence = null;
  const sectionBuffer = [];

  // Free-form prose sections are accumulated into sectionBuffer and flushed
  // when the next `## ` heading (or EOF) is reached. `## Coach Directive` is
  // optional, author-supplied runtime guidance for the Coach (e.g. "reference
  // the learner's portfolio project", "offer this code") — it must round-trip
  // verbatim, so it gets the same buffer treatment as the exemplar.
  const flushSection = () => {
    if (currentSection === 'exemplar') exemplar = sectionBuffer.join('\n').trim();
    if (currentSection === 'coach_directive') coachDirective = sectionBuffer.join('\n').trim();
    if (currentSection === 'description') descriptionLines.push('', ...sectionBuffer);
  };

  for (const line of lines) {
    const wasFenced = !!fence;
    // Match the renderer's indented fences too: list containers can put a
    // closing fence more than three columns from the document's left edge.
    const marker = line.replace(/\r$/, '').match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (fence) {
        if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      } else if (marker[1][0] !== '`' || !marker[2].includes('`')) {
        fence = { marker: marker[1][0], length: marker[1].length };
      }
    }
    // Opening/closing fence lines belong to their section too. Headings and
    // objective-looking bullets inside a code example are literal content.
    const fenced = wasFenced || !!fence;
    if (!fenced && line.startsWith('# ') && !name) {
      name = line.slice(2).trim();
      continue;
    }

    if (!fenced && line.startsWith('## ')) {
      flushSection();
      sectionBuffer.length = 0;
      currentSection = line.slice(3).trim().toLowerCase().replace(/\s+/g, '_');
      continue;
    }

    if (currentSection === null && name) {
      descriptionLines.push(line);
      continue;
    }

    if (currentSection === 'exemplar' || currentSection === 'coach_directive' || currentSection === 'description') {
      sectionBuffer.push(line);
    }

    if (!fenced && currentSection === 'learning_objectives') {
      const match = line.match(/^-\s+(.+)/);
      if (match) objectives.push(match[1].trim());
    }
  }

  flushSection();

  const parsed = { lessonId, name, description: toParagraphs(descriptionLines), exemplar, learningObjectives: objectives };
  if (coachDirective) parsed.coachDirective = coachDirective;
  return parsed;
}
