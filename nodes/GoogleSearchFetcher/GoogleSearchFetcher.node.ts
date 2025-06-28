/* eslint-disable n8n-nodes-base/node-param-description-boolean-without-whether */
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

interface KeyFact {
	text: string;
	source: string;
	url: string;
	relevance: number;
}

interface SearchResult {
	content: string;
	title: string;
	url: string;
}

/**
 * Извлекает ключевую информацию из результатов поиска
 */
function smartExtractKeyInfo(searchResults: SearchResult[], userQuery: string, maxFacts: number = 5): KeyFact[] {
	const queryKeywords = new Set(userQuery.toLowerCase().split(/\s+/).filter(word => word.length > 2));
	const keyFacts: KeyFact[] = [];

	for (const result of searchResults) {
		const content = result.content || '';
		
		// Разбиваем на предложения
		const sentences = content.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
		
		// Оцениваем релевантность каждого предложения
		for (const sentence of sentences) {
			if (sentence.length < 20) continue; // Пропускаем короткие предложения
			
			// Подсчет пересечений с ключевыми словами запроса
			const sentenceWords = new Set(sentence.toLowerCase().split(/\s+/));
			const intersection = new Set([...queryKeywords].filter(x => sentenceWords.has(x)));
			const relevanceScore = intersection.size;
			
			if (relevanceScore > 0) {
				keyFacts.push({
					text: sentence.length > 200 ? sentence.substring(0, 200) + '...' : sentence,
					source: result.title || 'Unknown',
					url: result.url || '',
					relevance: relevanceScore
				});
			}
		}
	}

	// Сортировка по релевантности и удаление дубликатов
	const uniqueFacts = removeDuplicateFacts(keyFacts);
	uniqueFacts.sort((a, b) => b.relevance - a.relevance);
	
	return uniqueFacts.slice(0, maxFacts);
}

/**
 * Удаляет дублирующиеся факты на основе сходства текста
 */
function removeDuplicateFacts(facts: KeyFact[]): KeyFact[] {
	const uniqueFacts: KeyFact[] = [];
	
	for (const fact of facts) {
		const isDuplicate = uniqueFacts.some(existing => 
			calculateTextSimilarity(fact.text, existing.text) > 0.7
		);
		
		if (!isDuplicate) {
			uniqueFacts.push(fact);
		}
	}
	
	return uniqueFacts;
}

/**
 * Вычисляет сходство между двумя текстами (простая реализация)
 */
function calculateTextSimilarity(text1: string, text2: string): number {
	const words1 = new Set(text1.toLowerCase().split(/\s+/));
	const words2 = new Set(text2.toLowerCase().split(/\s+/));
	
	const intersection = new Set([...words1].filter(x => words2.has(x)));
	const union = new Set([...words1, ...words2]);
	
	return intersection.size / union.size;
}

/**
 * Очищает HTML и извлекает основной текст
 */
function extractCleanText(html: string): string {
	const $ = cheerio.load(html);
	
	// Удаляем ненужные элементы
	$('script, style, nav, footer, form, noscript, iframe, svg, header, aside, .advertisement, .ad').remove();
	
	// Приоритет основному контенту
	const mainContent = $('main, article, .content, .post, .entry').first();
	const text = mainContent.length > 0 ? mainContent.text() : $('body').text();
	
	// Очистка текста
	return text.replace(/\s+/g, ' ').trim();
}

export class GoogleSearchFetcher implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Search Fetcher',
		name: 'googleSearchFetcher',
		group: ['transform'],
		version: 1,
		description: 'Search Google and fetch clean text from top N sites with smart key information extraction',
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
			{
				displayName: 'Enable Key Information Extraction',
				name: 'enableKeyExtraction',
				type: 'boolean',
				default: true,
				description: 'Extract only key information to optimize context length',
			},
			{
				displayName: 'Max Key Facts',
				name: 'maxKeyFacts',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 100,
				},
				default: 5,
				description: 'Maximum number of key facts to extract (only when key extraction is enabled)',
				displayOptions: {
					show: {
						enableKeyExtraction: [true],
					},
				},
			},
			{
				displayName: 'Max Text Length per Result',
				name: 'maxTextLength',
				type: 'number',
				typeOptions: {
					minValue: 100,
					maxValue: 5000,
				},
				default: 1000,
				description: 'Maximum text length per search result to avoid context overflow',
				displayOptions: {
					show: {
						enableKeyExtraction: [false],
					},
				},
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
				const enableKeyExtraction = this.getNodeParameter('enableKeyExtraction', i) as boolean;
				const maxKeyFacts = this.getNodeParameter('maxKeyFacts', i, 5) as number;
				const maxTextLength = this.getNodeParameter('maxTextLength', i, 1000) as number;

				// Выполняем поиск в Google
				const searchUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${cx}&num=${numResults}`;
				const searchResponse = await axios.get(searchUrl);
				const searchItems = searchResponse.data.items || [];

				const searchResults: SearchResult[] = [];
				const links: string[] = searchItems.map((item: any) => item.link);

				// Получаем контент с каждого сайта параллельно
				const fetchPromises = searchItems.map(async (item: any, j: number) => {
					const link = item.link;
					
					try {
						const htmlResponse = await axios.get(link, {
							headers: { 'User-Agent': 'Mozilla/5.0 (n8n-bot)' },
							timeout: 5000, // Уменьшил до 5 секунд для быстрого отклика
						});
						
						const cleanText = extractCleanText(htmlResponse.data);
						
						return {
							content: cleanText,
							title: item.title || `Result ${j + 1}`,
							url: link
						};
					} catch (htmlError: any) {
						return {
							content: `Failed to fetch or parse ${link}: ${htmlError.message}`,
							title: `Error - ${item.title || `Result ${j + 1}`}`,
							url: link
						};
					}
				});

				// Ждем завершения всех запросов параллельно
				const fetchedResults = await Promise.all(fetchPromises);
				searchResults.push(...fetchedResults);

				// Подготавливаем результат в зависимости от настроек
				let finalResult: any = {
					query,
					links,
					totalResults: searchResults.length,
					timestamp: new Date().toISOString(),
				};

				if (enableKeyExtraction) {
					// Извлекаем ключевую информацию
					const keyFacts = smartExtractKeyInfo(searchResults, query, maxKeyFacts);
					
					finalResult = {
						...finalResult,
						keyFacts,
						extractionMode: 'key_facts',
						factsCount: keyFacts.length,
						// Добавляем краткую сводку
						summary: keyFacts.slice(0, 3).map(fact => fact.text).join(' '),
					};
				} else {
					// Возвращаем полный текст с ограничением длины
					const texts = searchResults.map(result => 
						result.content.length > maxTextLength 
							? result.content.substring(0, maxTextLength) + '...'
							: result.content
					);
					
					finalResult = {
						...finalResult,
						texts,
						extractionMode: 'full_text',
						sources: searchResults.map(result => ({
							title: result.title,
							url: result.url,
							textLength: result.content.length
						}))
					};
				}

				results.push({
					json: finalResult,
				});

			} catch (error: any) {
				if (this.continueOnFail()) {
					results.push({ 
						json: { 
							error: error.message,
							query: this.getNodeParameter('query', i) as string,
							timestamp: new Date().toISOString()
						}, 
						pairedItem: i 
					});
				} else {
					throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				}
			}
		}

		return [results];
	}
}