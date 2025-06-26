/* eslint-disable n8n-nodes-base/node-param-type-options-password-missing */
/* eslint-disable n8n-nodes-base/node-filename-against-convention */
/* eslint-disable n8n-nodes-base/node-execute-block-wrong-error-thrown */
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import axios from 'axios';
import * as cheerio from 'cheerio';

export class GoogleSerpApiFetcher implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Search via SerpAPI',
		name: 'googleSerpApiFetcher',
		group: ['transform'],
		version: 1,
		description: 'Search Google via SerpAPI and fetch clean text from top N sites',
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
				placeholder: 'e.g. What is quantum computing?',
				description: 'Query to search in Google',
			},
			{
				displayName: 'Number of Results',
				name: 'numResults',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 10,
				},
				default: 5,
				description: 'Number of top results to retrieve (1–10)',
			},
			{
				displayName: 'SerpAPI Key',
				name: 'serpApiKey',
				type: 'string',
				default: '',
				description: 'Your SerpAPI key from serpapi.com',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const results: INodeExecutionData[] = [];
		const inputItems = this.getInputData();

		for (let i = 0; i < inputItems.length; i++) {
			try {
				const query = this.getNodeParameter('query', i) as string;
				const numResults = this.getNodeParameter('numResults', i) as number;
				const serpApiKey = this.getNodeParameter('serpApiKey', i) as string;

				const searchUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${serpApiKey}`;

				this.logger?.info(`🔍 Querying Google via SerpAPI: "${query}"`);

				const response = await axios.get(searchUrl);
                console.log(72, response);
				const organicResults = response.data.organic_results || [];

				if (organicResults.length === 0) {
					throw new Error('No results returned from SerpAPI.');
				}

				const links = organicResults.slice(0, numResults).map((r: any) => r.link);

				this.logger?.info(`🔗 Retrieved ${links.length} links`);

				// Параллельно вытаскиваем тексты с сайтов
				const cleanTexts = await Promise.all(
					links.map(async (link: string) => {
						try {
							const htmlResponse = await axios.get(link, {
								headers: {
									'User-Agent': 'Mozilla/5.0 (n8n-bot)',
								},
								timeout: 8000,
							});

							const $ = cheerio.load(htmlResponse.data);
							$('script, style, nav, footer, form, noscript, iframe, svg').remove();
							const text = $('body').text().replace(/\s+/g, ' ').trim();

							return text.length > 100 ? text.slice(0, 1000) : text;
						} catch (err) {
							this.logger?.warn(`❌ Failed to fetch ${link}: ${err.message}`);
							return `Failed to fetch ${link}: ${err.message}`;
						}
					})
				);

				results.push({
					json: {
						query,
						links,
						texts: cleanTexts,
					},
				});
			} catch (error) {
				this.logger?.error(`❌ Error: ${error.message}`);
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
