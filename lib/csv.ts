import { createReadStream } from 'node:fs';

/**
 * Streaming CSV reader.
 *
 * NHS England's full extract quotes fields that contain commas — commissioner
 * names such as "NHS BATH AND NORTH EAST SOMERSET, SWINDON AND WILTSHIRE ICB"
 * are split by naive comma splitting, which silently misaligns every column
 * after them. It streams because the extract runs to tens of megabytes.
 */
export async function* csvRows(file: string): AsyncGenerator<string[]> {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawClosingQuote = false;

  for await (const chunk of stream) {
    for (const character of chunk as string) {
      if (inQuotes) {
        if (character === '"') {
          // A doubled quote inside a quoted field is one literal quote.
          if (sawClosingQuote) {
            field += '"';
            sawClosingQuote = false;
          } else {
            sawClosingQuote = true;
          }
          continue;
        }
        if (sawClosingQuote) {
          sawClosingQuote = false;
          inQuotes = false;
          // fall through and handle this character as unquoted
        } else {
          field += character;
          continue;
        }
      }

      if (character === '"' && field === '') {
        inQuotes = true;
      } else if (character === ',') {
        row.push(field);
        field = '';
      } else if (character === '\n') {
        row.push(field);
        yield row;
        row = [];
        field = '';
      } else if (character !== '\r') {
        field += character;
      }
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    yield row;
  }
}

/** Reads the header row and returns a name to index lookup. */
export function headerIndex(header: string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, i) => index.set(name.trim(), i));
  return index;
}
