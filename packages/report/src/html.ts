/** A fragment of HTML that is safe to insert as is: built by {@link html} or {@link raw}. */
export class Html {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  toString(): string {
    return this.#value;
  }
}

/** What {@link html} accepts in `${}`: text (escaped), safe fragments, or lists of them. */
export type Interpolation =
  Html | string | number | boolean | null | undefined | readonly Interpolation[];

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** `text` with `&`, `<`, `>`, `"` and `'` escaped: safe in element content and quoted attributes. Pure. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/**
 * Tagged template for HTML. **Every interpolated value is escaped** unless it is already an
 * {@link Html} fragment; lists are joined; `null`, `undefined` and `false` render nothing. Values
 * from the repository, the PR or responses can therefore never become markup. Pure.
 */
export function html(strings: TemplateStringsArray, ...values: readonly Interpolation[]): Html {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

/**
 * Marks a string as safe HTML without escaping it. Only for bdiff's own constants (the report's
 * CSS and script); never for anything from a run.
 */
export function raw(trusted: string): Html {
  return new Html(trusted);
}

function render(value: Interpolation): string {
  if (value instanceof Html) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(render).join('');
  }
  if (value === null || value === undefined || value === false) {
    return '';
  }
  return escapeHtml(String(value));
}
