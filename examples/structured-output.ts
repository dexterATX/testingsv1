/**
 * Pattern 2 — synthesized search when you want grounded output.
 *
 * `systemPrompt` sets behavior and source preferences; `outputSchema` sets the
 * shape of `output.content`. Exa returns field-level citations in
 * `output.grounding` automatically — do not put citation or confidence fields
 * in the schema yourself.
 *
 *   npm run example:structured
 */

import { ExaClient, type JsonSchema } from '../src/index.js';

const exa = new ExaClient();

/** The shape we expect back, mirrored by the schema below. */
interface CompanyReport {
  companies: Array<{ name: string; description?: string }>;
}

const outputSchema: JsonSchema = {
  type: 'object',
  description: 'Companies mentioned in articles',
  required: ['companies'],
  properties: {
    companies: {
      type: 'array',
      description: 'List of companies mentioned',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Name of the company' },
          description: {
            type: 'string',
            description: 'Short description of what the company does',
          },
        },
      },
    },
  },
};

const response = await exa.search<CompanyReport>('articles about GPUs', {
  type: 'deep',
  systemPrompt:
    'Prefer official sources, collapse duplicate reporting, and keep the output grounded.',
  outputSchema,
  contents: { highlights: true },
});

const companies = response.output?.content.companies ?? [];

for (const company of companies) {
  console.log(`- ${company.name}${company.description ? `: ${company.description}` : ''}`);
}

console.log('\ngrounding:');
for (const entry of response.output?.grounding ?? []) {
  const sources = entry.citations.map((citation) => citation.url).join(', ');
  console.log(`  ${entry.field} [${entry.confidence}] ${sources}`);
}
