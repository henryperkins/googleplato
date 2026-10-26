export function buildContext(lesson, lessonKB, profileSummary, learnerName, courseProgress) {
  const completed = lessonKB?.activitiesCompleted || 0;
  const lessonStatus = lessonKB?.status === 'completed' ? 'completed' : 'active';
  const context = {
    learnerName: learnerName || '', lessonName: lesson.name, lessonDescription: lesson.description,
    exemplar: lesson.exemplar, lessonStatus,
    assessmentRequirements: { exemplar: lesson.exemplar, objectives: lesson.learningObjectives || (lessonKB?.objectives || []).map(item => item.objective), authorDirective: lesson.coachDirective || '' },
    objectives: (lessonKB?.objectives || []).map(({ evidence, ...item }) => ({ ...item, evidenceGuidance: evidence || '' })),
    insights: (Array.isArray(lessonKB?.insights) ? lessonKB.insights : []).filter(item => typeof item === 'string' && !item.startsWith('[Earlier:')).slice(-10).map(item => item.slice(0, 300)), learnerProfile: profileSummary || 'No profile yet',
    learnerPosition: lessonKB?.learnerPosition || 'New learner', progress: lessonKB?.progress ?? 0,
    assessmentReviewRequired: lessonKB?.assessmentReviewRequired === true,
    activitiesCompleted: completed, evidence: lessonKB?.evidence || [],
    exemplarEvidence: lessonKB?.exemplarEvidence || { status: 'missing', observation: '', sourceIds: [] },
    sources: lessonKB?.sources || [],
  };
  if (lesson.coachDirective) context.coachDirective = lesson.coachDirective;
  if (lesson.course?.name) context.course = { name: lesson.course.name, ...(courseProgress ? { progress: courseProgress } : {}) };
  if (Array.isArray(lessonKB?.enrichments) && lessonKB.enrichments.length) context.enrichmentContext = lessonKB.enrichments.slice(0, 5).map(item => ({
    source: String(item.source || item.label || item.pluginId || 'Reference').slice(0, 200),
    context: String(item.context || '').slice(0, 6000), reasoning: String(item.reasoning || '').slice(0, 500),
    sources: Array.isArray(item.sources) ? item.sources.filter(source => /^https?:\/\//i.test(source?.url || '')).slice(0, 5).map(source => ({ url: String(source.url || '').slice(0, 2048), title: String(source.title || '').slice(0, 200) })) : [],
  }));
  if (lessonStatus === 'completed') {
    context.postCompletionDirective = 'This lesson is already complete. Stay in feedback mode only and report progress 10. Preserve demonstrated evidence. Do not assess or award credit for another lesson in this thread; tell the learner to start the next lesson separately.';
  } else if (completed >= 8) {
    context.pacingDirective = `${completed >= 20 ? 'The lesson has run well past its target; note a lesson-design mismatch if relevant.' : completed >= 11 ? 'The target exchange count is reached.' : 'Approaching the target exchange count.'} Focus on one remaining required criterion with a small next step. Keep every required objective and the exemplar unchanged. Award 10 only when all required evidence is demonstrated; otherwise continue or respect the learner’s request to pause.`;
  }
  return JSON.stringify(context);
}
