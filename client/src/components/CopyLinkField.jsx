import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { copyText } from '../lib/clipboard.js';

const COPIED_MS = 4000;

function selectAll(el) {
  el.select();
  // iOS Safari ignores select() on read-only inputs.
  el.setSelectionRange(0, el.value.length);
}

/**
 * A link to copy: a read-only field plus a Copy button. The field is the
 * fallback when clipboard access is denied or unavailable — a failed copy
 * focuses and selects it and says how to copy by hand. Both outcomes are
 * announced through a polite status region that stays mounted (an inserted
 * live region isn't reliably read).
 */
export default function CopyLinkField({ id, label, value, copyLabel }) {
  const autoId = useId();
  const inputId = id || autoId;
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const [result, setResult] = useState(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  async function handleCopy() {
    clearTimeout(timerRef.current);
    if (await copyText(value)) {
      setResult('copied');
      timerRef.current = setTimeout(() => setResult(null), COPIED_MS);
    } else {
      setResult('failed');
      inputRef.current?.focus();
      if (inputRef.current) selectAll(inputRef.current);
    }
  }

  return (
    <div>
      <Label htmlFor={inputId}>{label}</Label>
      <div className="mt-2 flex gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          readOnly
          value={value}
          onFocus={(e) => selectAll(e.target)}
          className="font-mono text-base md:text-sm"
        />
        <Button type="button" variant="outline" onClick={handleCopy} aria-label={copyLabel}>
          Copy
        </Button>
      </div>
      <p role="status" className={`mt-1.5 text-sm empty:mt-0 ${result === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
        {result === 'copied' && 'Copied to the clipboard.'}
        {result === 'failed' && "Couldn't copy automatically. The link is selected — press Ctrl+C (⌘C on a Mac), or copy it from the field."}
      </p>
    </div>
  );
}
