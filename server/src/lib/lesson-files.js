import { createHash } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { realpathSync } from 'node:fs';

export const validLessonId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);

// Never interpret stored IDs as paths. A digest also bounds the filename for
// long, Unicode and already-encoded legacy identifiers without collisions.
export const lessonFilename = id => `lesson-${createHash('sha256').update(id).digest('hex')}.md`;

export function lessonFile(directory, filename, { existing = false } = {}) {
  if (typeof filename !== 'string' || !filename || basename(filename) !== filename || !filename.endsWith('.md')) {
    throw new Error('Unsafe lesson filename');
  }
  const root = realpathSync(directory);
  const file = resolve(root, filename);
  if (dirname(file) !== root || (existing && dirname(realpathSync(file)) !== root)) throw new Error('Lesson file escapes export directory');
  return file;
}
