/* eslint-disable n8n-nodes-base/node-filename-against-convention */
/* eslint-disable n8n-nodes-base/node-execute-block-wrong-error-thrown */
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
import { URLSearchParams } from 'url';

export class DuckDuckGoSearchFetcher implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DuckDuckGo Fetcher',
		name: 'duckDuckGoFetcher',
		group: ['transform'],
		version: 1,
		description: 'Search DuckDuckGo and fetch clean text from top N sites',
		defaults: {
			name: 'DuckDuckGo Fetcher',
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
				description: 'Query to search in DuckDuckGo',
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
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const results: INodeExecutionData[] = [];
		const inputItems = this.getInputData();

		for (let i = 0; i < inputItems.length; i++) {
			try {
				const query = this.getNodeParameter('query', i) as string;
				const numResults = this.getNodeParameter('numResults', i) as number;

				this.logger?.info(`🔍 Performing DuckDuckGo search for query: "${query}"`);

				// Perform search
				const searchResponse = await axios.post(
					'https://html.duckduckgo.com/html',
					new URLSearchParams({ q: query }).toString(),
					{
						headers: {
							'Content-Type': 'application/x-www-form-urlencoded',
							'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
							'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
							'Accept-Language': 'en-US,en;q=0.5',
							'Referer': 'https://duckduckgo.com/',
							'Origin': 'https://duckduckgo.com',
						},
						validateStatus: (status) => status < 400, // ⚠️ Позволяет обрабатывать 202, 204, и т.д.
					}
				);

				if (searchResponse.status !== 200) {
					throw new Error(`Search request failed with status ${searchResponse.status}`);
				}

				const $ = cheerio.load(searchResponse.data);
				const links: string[] = [];

				$('a.result__a').each((_, el) => {
					const href = $(el).attr('href');
					if (href && links.length < numResults) {
						links.push(href);
					}
				});

				this.logger?.info(`🔗 Found ${links.length} links from DuckDuckGo`);

				if (links.length === 0) {
					this.logger?.warn('⚠️ No search results returned. Possible bot block or selector mismatch.');
				}

				const cleanTexts: string[] = [];

				for (const link of links) {
					try {
						this.logger?.debug(`🌐 Fetching content from: ${link}`);

						const htmlResponse = await axios.get(link, {
							headers: {
								'User-Agent': 'Mozilla/5.0 (n8n-bot)',
							},
							timeout: 7000,
						});

						const $ = cheerio.load(htmlResponse.data);
						$('script, style, nav, footer, form, noscript, iframe, svg').remove();
						const text = $('body').text();
						const cleanText = text.replace(/\s+/g, ' ').trim();

						this.logger?.debug(`✅ Fetched ${cleanText.length} characters from: ${link}`);
						cleanTexts.push(cleanText);
					} catch (htmlError) {
						this.logger?.error(`❌ Failed to fetch or parse ${link}: ${htmlError.message}`);
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
				this.logger?.error(`❌ Node error: ${error.message}`);
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
