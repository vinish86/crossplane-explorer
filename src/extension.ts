// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { CrossplaneExplorerProvider, CrossplaneResource } from './crossplaneExplorer';
import { executeCommand, executeCommandWithStdin } from './utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

const resourceToTempFileMap = new Map<string, string>();
const tempFileToResourceMap = new Map<string, CrossplaneResource>();
const openingResources = new Set<string>();

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "crossplane-explorer" is now active!');

	const crossplaneExplorerProvider = new CrossplaneExplorerProvider();
	context.subscriptions.push(vscode.window.registerTreeDataProvider('crossplaneExplorer', crossplaneExplorerProvider));

	context.subscriptions.push(vscode.commands.registerCommand('crossplane-explorer.refresh', () => {
		crossplaneExplorerProvider.refresh();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('crossplane-explorer.openResource', async (resource: CrossplaneResource) => {
		if (!resource.resourceType || !resource.resourceName) {
			vscode.window.showErrorMessage('Cannot open resource: resource name is missing.');
			return;
		}
		
		const resourceKey = `${resource.resourceType}:${resource.namespace || ''}:${resource.resourceName}`;
        if (openingResources.has(resourceKey)) {
            return; // Already in the process of opening
        }

        if (resourceToTempFileMap.has(resourceKey)) {
            const tempFilePath = resourceToTempFileMap.get(resourceKey)!;
            try {
                const doc = await vscode.workspace.openTextDocument(tempFilePath);
                await vscode.window.showTextDocument(doc, { preview: false });
                return;
            } catch (error) {
                // The file might have been deleted manually, so we'll proceed to create it again.
                resourceToTempFileMap.delete(resourceKey);
                tempFileToResourceMap.delete(tempFilePath);
            }
        }
		
		try {
            openingResources.add(resourceKey);

			const getArgs = ['get', resource.resourceType, resource.resourceName];
			if (resource.namespace) {
				getArgs.push('-n', resource.namespace);
			}
			getArgs.push('-o', 'yaml');
			const { stdout } = await executeCommand('kubectl', getArgs);

			// Clean the YAML before writing to file
			const resourceYaml: any = yaml.load(stdout);
			if (resourceYaml && resourceYaml.metadata) {
				delete resourceYaml.metadata.uid;
				delete resourceYaml.metadata.resourceVersion;
				delete resourceYaml.metadata.creationTimestamp;
				delete resourceYaml.metadata.managedFields;
				delete resourceYaml.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration'];
			}
			delete resourceYaml.status;
			const cleanedYaml = yaml.dump(resourceYaml);
			
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossplane-explorer-'));
            const fileName = `${resource.resourceType}-${resource.resourceName}.yaml`;
            const tempFilePath = path.join(tempDir, fileName);
            fs.writeFileSync(tempFilePath, cleanedYaml);
            
            resourceToTempFileMap.set(resourceKey, tempFilePath);
            tempFileToResourceMap.set(tempFilePath, resource);

			const doc = await vscode.workspace.openTextDocument(tempFilePath);
			await vscode.window.showTextDocument(doc, { preview: false });
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to get resource YAML: ${err.message}`);
		} finally {
            openingResources.delete(resourceKey);
        }
	}));

	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
        const filePath = document.uri.fsPath;
        if (tempFileToResourceMap.has(filePath)) {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Applying changes to ${path.basename(filePath)}...`,
                cancellable: false
            }, async () => {
                try {
                    const fileContent = document.getText();
                    const { stderr } = await executeCommandWithStdin('kubectl', ['apply', '-f', '-', '--server-side', '--force-conflicts'], fileContent);
                    
                    if (stderr) {
                         vscode.window.showErrorMessage(`Failed to apply changes: ${stderr}`);
                         return;
                    }
                    vscode.window.showInformationMessage(`Successfully applied changes to ${path.basename(filePath)}`);
					crossplaneExplorerProvider.refresh();
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to apply changes: ${err.message}`);
                }
            });
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
        const filePath = document.uri.fsPath;
        if (tempFileToResourceMap.has(filePath)) {
            const resource = tempFileToResourceMap.get(filePath)!;
            const resourceKey = `${resource.resourceType}:${resource.namespace || ''}:${resource.resourceName}`;
            
            const dirPath = path.dirname(filePath);
            fs.unlink(filePath, (err) => {
                if (err) { console.error(`Failed to delete temp file ${filePath}: ${err}`); }
                fs.rmdir(dirPath, (rmdirErr) => {
                    if (rmdirErr) { console.error(`Failed to delete temp dir ${dirPath}: ${rmdirErr}`); }
                });
            });
            tempFileToResourceMap.delete(filePath);
            resourceToTempFileMap.delete(resourceKey);
        }
    }));

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('crossplane-explorer.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Crossplane Explorer!');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
