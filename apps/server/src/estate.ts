import type { DatabaseSync } from 'node:sqlite';

/**
 * Does the estate have a line that answers to this number?
 *
 * The adaptor cannot answer this. It registers whatever identity it is handed and
 * reports itself registered, so a port pointed at `999` looks perfectly healthy
 * on the device sheet — "registered" — and rings nowhere, because nothing behind
 * the switch answers to that number. Only the platform knows which extensions
 * exist.
 *
 * The result is a warning rather than a refusal on purpose. The estate's own 201
 * and 202 were put on the hardware before this platform had a line for them, and
 * an operator may be deliberately ahead of the inventory; blocking the write
 * would make the adaptor sheet unable to do the job it was built for.
 */
export function unknownExtensionWarning(db: DatabaseSync, extension: string): string | null {
  // Bound, never interpolated: this value comes straight from a form.
  const row = db.prepare('SELECT id FROM lines WHERE extension = ?').get(extension);
  if (row) return null;
  return `No line in this estate uses ${extension}, so the port will register and then ring nowhere until one does.`;
}
