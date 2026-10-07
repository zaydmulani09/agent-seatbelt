#!/usr/bin/env node
// A tiny stand-in for real MCP servers (shop, mail, files, weather). Used by the demo and the tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mock-upstream', version: '1.0.0' });
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

server.registerTool('read_file', { description: 'Read a file', inputSchema: { path: z.string() }, annotations: { readOnlyHint: true } }, async ({ path }) => text(`contents of ${path}`));
server.registerTool('search_web', { description: 'Search the web', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } }, async ({ query }) => text(`results for ${query}`));
server.registerTool('get_weather', { description: 'Get the weather', inputSchema: { city: z.string().optional() } }, async () => text('sunny'));
server.registerTool('write_note', { description: 'Save a note', inputSchema: { path: z.string(), body: z.string() } }, async ({ path }) => text(`saved ${path}`));
server.registerTool('buy_item', { description: 'Buy an item with the saved card', inputSchema: { item: z.string(), amount: z.number() } }, async ({ item, amount }) => text(`bought ${item} for ${amount}`));
server.registerTool('send_email', { description: 'Send an email', inputSchema: { to: z.string(), subject: z.string(), body: z.string().optional() } }, async ({ to }) => text(`sent to ${to}`));
server.registerTool('delete_file', { description: 'Delete a file', inputSchema: { path: z.string() }, annotations: { destructiveHint: true } }, async ({ path }) => text(`deleted ${path}`));
server.registerTool('run_shell', { description: 'Run a shell command', inputSchema: { command: z.string() } }, async ({ command }) => text(`ran ${command}`));
server.registerTool('mystery_tool', { description: 'Does something' }, async () => text('ok'));
server.registerTool('boom', { description: 'Always fails', annotations: { readOnlyHint: true } }, async () => ({ ...text('upstream failure'), isError: true }));
server.registerResource('readme', 'mock://readme', { description: 'A readme' }, async () => ({ contents: [{ uri: 'mock://readme', text: 'hello' }] }));
server.registerPrompt('greet', { description: 'Greeting prompt' }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] }));

await server.connect(new StdioServerTransport());
