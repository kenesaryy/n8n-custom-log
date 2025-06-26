/* eslint-disable n8n-nodes-base/node-dirname-against-convention */
/* eslint-disable n8n-nodes-base/node-param-type-options-password-missing */
/* eslint-disable n8n-nodes-base/node-filename-against-convention */
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import axios from 'axios';
import * as cheerio from 'cheerio';

export class GoogleSearchFetcher implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Search Fetcher',
		name: 'googleSearchFetcher',
		group: ['transform'],
		version: 1,
		description: 'Search Google and fetch clean text from top N sites',
		defaults: {
			name: 'Google Search Fetcher',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Search Query',
				name: 'query',
				type: 'string',
				default: '',
				placeholder: 'e.g. OpenAI GPT-4',
				description: 'Query to search in Google',
			},
			{
				displayName: 'API Key',
				name: 'apiKey',
				type: 'string',
				default: '',
				description: 'Google Custom Search API Key',
			},
			{
				displayName: 'Search Engine ID (CX)',
				name: 'cx',
				type: 'string',
				default: '',
				description: 'Google Custom Search Engine ID',
			},
			{
				displayName: 'Number of Results',
				name: 'numResults',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 10, // API ограничение Google
				},
				default: 5,
				description: 'Number of top results to retrieve (1–10)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const results: INodeExecutionData[] = [];
		const inputItems = this.getInputData();

		for (let i = 0; i < inputItems.length; i++) {
			try {
				const query = this.getNodeParameter('query', i) as string;
				const apiKey = this.getNodeParameter('apiKey', i) as string;
				const cx = this.getNodeParameter('cx', i) as string;
				const numResults = this.getNodeParameter('numResults', i) as number;

				const searchUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${cx}&num=${numResults}`;

				const searchResponse = await axios.get(searchUrl);
				const links: string[] = searchResponse.data.items?.map((item: any) => item.link) ?? [];

				const cleanTexts: string[] = [];

				for (const link of links) {
					try {
						const htmlResponse = await axios.get(link, {
							headers: { 'User-Agent': 'Mozilla/5.0 (n8n-bot)' },
							timeout: 7000,
						});

						const $ = cheerio.load(htmlResponse.data);

						$('script, style, nav, footer, form, noscript, iframe, svg').remove();

						const text = $('body').text();
						const cleanText = text.replace(/\s+/g, ' ').trim();

						cleanTexts.push(cleanText);
					} catch (htmlError) {
						cleanTexts.push(`Failed to fetch or parse ${link}: ${htmlError.message}`);
					}
				}

				results.push({
					json: {
						query,
						links,
						texts: cleanTexts,
					},
				});
			} catch (error) {
				if (this.continueOnFail()) {
					results.push({ json: { error: error.message }, pairedItem: i });
				} else {
					throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				}
			}
		}

		return [results];
	}
}
