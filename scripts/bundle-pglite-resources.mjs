/* eslint-disable */
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function bundlePgliteResources() {
	const pgliteVersion = '0.2.14'
	const pglitePath = path.resolve(
		__dirname,
		'../node_modules/@electric-sql/pglite',
	)

	// Read the files
	const wasmBuffer = await fs.readFile(
		path.join(pglitePath, 'dist/postgres.wasm'),
	)
	const dataBuffer = await fs.readFile(
		path.join(pglitePath, 'dist/postgres.data'),
	)
	const vectorBuffer = await fs.readFile(
		path.join(pglitePath, 'dist/vector.tar.gz'),
	)

	// Convert to base64
	const wasmBase64 = wasmBuffer.toString('base64')
	const dataBase64 = dataBuffer.toString('base64')
	const vectorBase64 = vectorBuffer.toString('base64')

	// Create the output file
	const output = `
// This file is auto-generated. Do not edit manually.
export const pgliteResources = {
  wasmBase64: '${wasmBase64}',
  dataBase64: '${dataBase64}',
  vectorBase64: '${vectorBase64}',
};
`

	// Write the bundled resources
	await fs.writeFile(
		path.resolve(__dirname, '../src/database/modules/pglite-resources.ts'),
		output,
	)
	console.log('Bundled pglite resources')
}

bundlePgliteResources().catch(console.error)
