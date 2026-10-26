export function parseLessonPrompt(lessonId, markdown) {
  const lines = markdown.split('\n');
  let name = '';
  let description = '';
  let exemplar = '';
  let coachDirective = '';
  const objectives = [];
  let currentSection = null;
  const sectionBuffer = [];

  // Free-form prose sections are accumulated into sectionBuffer and flushed
  // when the next `## ` heading (or EOF) is reached. `## Coach Directive` is
  // optional, author-supplied runtime guidance for the Coach (e.g. "reference
  // the learner's portfolio project", "offer this code") — it must round-trip
  // verbatim, so it gets the same buffer treatment as the exemplar.
  const flushSection = () => {
    if (currentSection === 'exemplar') exemplar = sectionBuffer.join('\n').trim();
    if (currentSection === 'coach_directive') coachDirective = sectionBuffer.join('\n').trim();
  };

  for (const line of lines) {
    if (line.startsWith('# ') && !name) {
      name = line.slice(2).trim();
      continue;
    }

    if (line.startsWith('## ')) {
      flushSection();
      sectionBuffer.length = 0;
      currentSection = line.slice(3).trim().toLowerCase().replace(/\s+/g, '_');
      continue;
    }

    if (currentSection === null && line.trim() && name && !description) {
      description = line.trim();
      continue;
    }

    if (currentSection === 'exemplar' || currentSection === 'coach_directive') {
      sectionBuffer.push(line);
    }

    if (currentSection === 'learning_objectives') {
      const match = line.match(/^-\s+(.+)/);
      if (match) objectives.push(match[1].trim());
    }
  }

  flushSection();

  const parsed = { lessonId, name, description, exemplar, learningObjectives: objectives };
  if (coachDirective) parsed.coachDirective = coachDirective;
  return parsed;
}
