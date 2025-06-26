// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { CrossplaneExplorerProvider, CrossplaneResource } from './crossplaneExplorer';
import { executeCommand, executeCommandWithStdin } from './utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { exec } from 'child_process';
import * as Diff from 'diff'; // TODO: npm install diff
import type { Change } from 'diff';
import { createTwoFilesPatch } from 'diff';
import { diff as deepDiff, Diff as DeepDiff } from 'deep-diff';

const resourceToTempFileMap = new Map<string, string>();
const tempFileToResourceMap = new Map<string, string>();
const openingResources = new Set<string>();

// Map to track output channel to process
const logProcessMap = new WeakMap<vscode.OutputChannel, any>();

// Add at the top:
const fieldWatchMap = new Map<string, () => void>();
const fieldWatchOutputMap = new Map<string, vscode.OutputChannel>();

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

            let resourceType = resource.resourceType;
            if (resourceType === 'functions') {
                resourceType = 'functions.pkg.crossplane.io';
            }
            // Special handling for CRDs
            if (resourceType === 'crd') {
                resourceType = 'crd';
            }
            let getArgs: string[];
            if (
                resourceType === 'crd' ||
                resourceType === 'compositions' ||
                resourceType === 'providers' ||
                resourceType === 'functions.pkg.crossplane.io'
            ) {
                getArgs = ['get', resourceType, resource.resourceName];
            } else if (resourceType && resourceType.includes('.') && resource.resourceName) {
                getArgs = ['get', `${resourceType}/${resource.resourceName}`];
            } else {
                getArgs = ['get', resourceType, resource.resourceName];
            }
            if (resource.namespace) {
                getArgs.push('-n', resource.namespace);
            }
            getArgs.push('-o', 'yaml');

            // Debug log
            console.log('Running command:', 'kubectl', ...getArgs);

			const { stdout } = await executeCommand('kubectl', getArgs);

			// Clean the YAML before writing to file
			const resourceYaml: any = yaml.load(stdout);
			if (resourceYaml && resourceYaml.kind === 'List') {
				vscode.window.showErrorMessage('Selected item is not a single resource. Please select a specific object.');
				return;
			}
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
            tempFileToResourceMap.set(tempFilePath, resourceKey);

			const doc = await vscode.workspace.openTextDocument(tempFilePath);
			await vscode.window.showTextDocument(doc, { preview: true });
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to get resource YAML: ${err.message}`);
		} finally {
            openingResources.delete(resourceKey);
        }
	}));

	// Use separate temp files for view and edit modes
	function getResourceKey(resource: CrossplaneResource, mode: 'view' | 'edit') {
		return `${resource.resourceType}:${resource.namespace || ''}:${resource.resourceName}:${mode}`;
	}

	function getAllTempFilePaths(resource: CrossplaneResource) {
		const keys = [
			getResourceKey(resource, 'view'),
			getResourceKey(resource, 'edit')
		];
		return keys
			.map(key => resourceToTempFileMap.get(key))
			.filter((p): p is string => !!p);
	}

	context.subscriptions.push(vscode.commands.registerCommand('crossplane-explorer.viewResource', async (resource: CrossplaneResource) => {
		if (!resource.resourceType || !resource.resourceName) {
			vscode.window.showErrorMessage('Cannot view resource: resource name is missing.');
			return;
		}
		const resourceKey = getResourceKey(resource, 'view');
		if (openingResources.has(resourceKey)) {
			return;
		}
		try {
			openingResources.add(resourceKey);
			let resourceType = resource.resourceType;
			if (resourceType === 'functions') {
				resourceType = 'functions.pkg.crossplane.io';
			}
			if (resourceType === 'crd') {
				resourceType = 'crd';
			}
			let getArgs: string[];
			if (
				resourceType === 'crd' ||
				resourceType === 'compositions' ||
				resourceType === 'providers' ||
				resourceType === 'functions.pkg.crossplane.io'
			) {
				getArgs = ['get', resourceType, resource.resourceName];
			} else if (resourceType && resourceType.includes('.') && resource.resourceName) {
				getArgs = ['get', `${resourceType}/${resource.resourceName}`];
			} else {
				getArgs = ['get', resourceType, resource.resourceName];
			}
			if (resource.namespace) {
				getArgs.push('-n', resource.namespace);
			}
			getArgs.push('-o', 'yaml');
			const { stdout } = await executeCommand('kubectl', getArgs);
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossplane-explorer-'));
			const fileName = `${resource.resourceType}-${resource.resourceName}-view.yaml`;
			const tempFilePath = path.join(tempDir, fileName);
			const banneredYaml = `# VIEW MODE: This file is read-only\n${stdout}`;
			fs.writeFileSync(tempFilePath, banneredYaml);
			resourceToTempFileMap.set(resourceKey, tempFilePath);
			tempFileToResourceMap.set(tempFilePath, resourceKey);
			// Close any open tab for this resource (view or edit)
			const allPaths = getAllTempFilePaths(resource);
			for (const editor of vscode.window.visibleTextEditors) {
				if (allPaths.includes(editor.document.fileName)) {
					await vscode.window.showTextDocument(editor.document, { preview: true });
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				}
			}
			const doc = await vscode.workspace.openTextDocument(tempFilePath);
			await vscode.window.showTextDocument(doc, { preview: true });
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to view resource YAML: ${err.message}`);
		} finally {
			openingResources.delete(resourceKey);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('crossplane-explorer.editResource', async (resource: CrossplaneResource) => {
		if (!resource.resourceType || !resource.resourceName) {
			vscode.window.showErrorMessage('Cannot edit resource: resource name is missing.');
			return;
		}
		const resourceKey = getResourceKey(resource, 'edit');
		if (openingResources.has(resourceKey)) {
			return;
		}
		if (resourceToTempFileMap.has(resourceKey)) {
			const tempFilePath = resourceToTempFileMap.get(resourceKey)!;
			try {
				const doc = await vscode.workspace.openTextDocument(tempFilePath);
				await vscode.window.showTextDocument(doc, { preview: false });
				return;
			} catch (error) {
				resourceToTempFileMap.delete(resourceKey);
				tempFileToResourceMap.delete(tempFilePath);
			}
		}
		try {
			openingResources.add(resourceKey);
			let resourceType = resource.resourceType;
			if (resourceType === 'functions') {
				resourceType = 'functions.pkg.crossplane.io';
			}
			if (resourceType === 'crd') {
				resourceType = 'crd';
			}
			let getArgs: string[];
			if (
				resourceType === 'crd' ||
				resourceType === 'compositions' ||
				resourceType === 'providers' ||
				resourceType === 'functions.pkg.crossplane.io'
			) {
				getArgs = ['get', resourceType, resource.resourceName];
			} else if (resourceType && resourceType.includes('.') && resource.resourceName) {
				getArgs = ['get', `${resourceType}/${resource.resourceName}`];
			} else {
				getArgs = ['get', resourceType, resource.resourceName];
			}
			if (resource.namespace) {
				getArgs.push('-n', resource.namespace);
			}
			getArgs.push('-o', 'yaml');
			const { stdout } = await executeCommand('kubectl', getArgs);
			const resourceYaml: any = yaml.load(stdout);
			if (resourceYaml && resourceYaml.kind === 'List') {
				vscode.window.showErrorMessage('Selected item is not a single resource. Please select a specific object.');
				return;
			}
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
			const fileName = `${resource.resourceType}-${resource.resourceName}-edit.yaml`;
			const tempFilePath = path.join(tempDir, fileName);
			const banneredYaml = `# EDIT MODE: You can edit and apply changes to this resource\n${cleanedYaml}`;
			fs.writeFileSync(tempFilePath, banneredYaml);
			resourceToTempFileMap.set(resourceKey, tempFilePath);
			tempFileToResourceMap.set(tempFilePath, resourceKey);
			// Close any open tab for this resource (view or edit)
			const allPaths = getAllTempFilePaths(resource);
			for (const editor of vscode.window.visibleTextEditors) {
				if (allPaths.includes(editor.document.fileName)) {
					await vscode.window.showTextDocument(editor.document, { preview: false });
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				}
			}
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
                    // Validate YAML before applying
                    try {
                        yaml.load(fileContent);
                    } catch (e: any) {
                        vscode.window.showErrorMessage('YAML Error: ' + e.message);
                        return;
                    }
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

    // Update close logic to clean up correct temp file
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
        const filePath = document.uri.fsPath;
        if (tempFileToResourceMap.has(filePath)) {
            const resourceKey = tempFileToResourceMap.get(filePath)!;
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

	context.subscriptions.push(vscode.commands.registerCommand('crossplane-explorer.showPodDetails', async (resource: CrossplaneResource) => {
		if (!resource.resourceName || !resource.namespace) {
			vscode.window.showErrorMessage('Pod name or namespace missing.');
			return;
		}
		try {
			const { stdout, stderr } = await executeCommand('kubectl', [
				'get', 'pod', resource.resourceName, '-n', resource.namespace, '-o', 'yaml'
			]);
			if (stderr && !stdout) {
				vscode.window.showErrorMessage(stderr);
				return;
			}
			const banneredYaml = `# VIEW MODE: This file is read-only\n${stdout}`;
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossplane-explorer-'));
			const fileName = `pod-${resource.resourceName}-view.yaml`;
			const tempFilePath = path.join(tempDir, fileName);
			fs.writeFileSync(tempFilePath, banneredYaml);
			const doc = await vscode.workspace.openTextDocument(tempFilePath);
			await vscode.window.showTextDocument(doc, { preview: true });
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to get pod YAML: ${err.message}`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('crossplane-explorer.tailPodLogs', async (resource: CrossplaneResource) => {
		if (!resource.resourceName || !resource.namespace) {
			vscode.window.showErrorMessage('Pod name or namespace missing.');
			return;
		}
		const outputChannel = vscode.window.createOutputChannel(`Logs: ${resource.resourceName}`);
		outputChannel.show(true);
		outputChannel.appendLine(`# kubectl logs -f ${resource.resourceName} -n ${resource.namespace}`);
		const cp = require('child_process');
		const logProcess = cp.spawn('kubectl', [
			'logs', '-f', resource.resourceName, '-n', resource.namespace
		]);
		logProcess.stdout.on('data', (data: Buffer) => {
			outputChannel.append(data.toString());
		});
		logProcess.stderr.on('data', (data: Buffer) => {
			outputChannel.append(data.toString());
		});
		logProcess.on('close', (code: number) => {
			outputChannel.appendLine(`\n[Process exited with code ${code}]`);
		});
		logProcessMap.set(outputChannel, logProcess);
		// Dispose log process when output channel is closed
		const disposable = vscode.Disposable.from({
			dispose: () => {
				const proc = logProcessMap.get(outputChannel);
				if (proc) {
					proc.kill();
					logProcessMap.delete(outputChannel);
				}
			}
		});
		context.subscriptions.push(disposable);
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplane-explorer.cbtTrace', async (resource: any) => {
			if (!resource.resourceType || !resource.resourceName) {
				vscode.window.showErrorMessage('CBT: Resource type or name missing.');
				return;
			}

			// Compose the command
			const cmd = `crossplane beta trace ${resource.resourceType} ${resource.resourceName}`;

			const output = vscode.window.createOutputChannel('Crossplane CBT');
			output.show(true);
			output.appendLine(`# ${cmd}\n`);

			function pad(str: string, len: number) {
				return (str + ' '.repeat(len)).slice(0, len);
			}

			require('child_process').exec(cmd, { maxBuffer: 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
				if (err) {
					output.appendLine(`Error: ${err.message}`);
					return;
				}
				if (stderr) {
					output.appendLine(stderr);
				}
				// Try to parse as JSON, else show as plain text
				try {
					const result = JSON.parse(stdout);
					const obj = result.object;
					const name = `${obj.kind}/${obj.metadata.name}`;
					const synced = obj.status?.conditions?.find((c: any) => c.type === 'Synced')?.status || '-';
					const ready = obj.status?.conditions?.find((c: any) => c.type === 'Ready')?.status || '-';
					const statusMsg = obj.status?.conditions?.find((c: any) => c.type === 'Synced')?.message || '-';
					output.appendLine('┌───────────────────────────────┬────────┬───────┬─────────────────────────────────────────────┐');
					output.appendLine('│ NAME                          │ SYNCED │ READY │ STATUS                                      │');
					output.appendLine('├───────────────────────────────┼────────┼───────┼─────────────────────────────────────────────┤');
					output.appendLine(`│ ${pad(name, 28)} │ ${pad(synced, 6)} │ ${pad(ready, 5)} │ ${pad(statusMsg, 41)} │`);
					output.appendLine('└───────────────────────────────┴────────┴───────┴─────────────────────────────────────────────┘');
				} catch {
					output.appendLine(stdout);
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.showLiveDiff', async (resource: CrossplaneResource) => {
			const resourceKey = `${resource.resourceType}:${resource.namespace || ''}:${resource.resourceName}`;
			if (fieldWatchOutputMap.has(resourceKey)) {
				const existingOutput = fieldWatchOutputMap.get(resourceKey)!;
				existingOutput.show(true);
				existingOutput.appendLine('[INFO] Field Watch is already running for this resource.');
				return;
			}
			const output = vscode.window.createOutputChannel(`Field Watch: ${resource.resourceName}`);
			output.show(true);
			output.appendLine(`# Field Watch for ${resource.resourceType} ${resource.resourceName}${resource.namespace ? ' -n ' + resource.namespace : ''}\n`);
			fieldWatchOutputMap.set(resourceKey, output);

			if (!resource.resourceType) {
				output.appendLine('[ERROR] Resource type is missing.');
				return;
			}

			const k8sModule = await import('@kubernetes/client-node');
			const kc = new k8sModule.KubeConfig();
			kc.loadFromDefault();
			const k8sApi = kc.makeApiClient(k8sModule.ApiextensionsV1Api);
			const watch = new k8sModule.Watch(kc);

			// Dynamically fetch CRD details
			let kind = (resource as any).kind || '';
			let apiVersion = (resource as any).apiVersion || '';
			let group = '';
			if (apiVersion && apiVersion.includes('/')) {
				group = apiVersion.split('/')[0];
			}
			if (!kind) {
				const typeParts = resource.resourceType.split('.');
				kind = typeParts[0];
				if (!group) {
					group = typeParts.slice(1).join('.');
				}
			}
			let crdName = group ? `${kind.toLowerCase()}s.${group}` : `${kind.toLowerCase()}s`;
			if (!crdName) {
				output.appendLine(`[ERROR] CRD name could not be determined for resourceType: ${resource.resourceType}`);
				output.appendLine(`Please check the resource type or list available CRDs with 'kubectl get crd'.`);
				return;
			}
			let plural = '';
			let version = '';
			let scope = 'Namespaced';
			try {
				const resp = await (k8sApi.readCustomResourceDefinition as any)({ name: crdName });
				const crd = resp?.body || resp;
				if (!crd || !crd.spec) {
					output.appendLine(`[ERROR] CRD fetch for ${crdName} did not return a valid CRD object.`);
					output.appendLine(`[DEBUG] Response: ${JSON.stringify(resp)}`);
					return;
				}
				plural = crd.spec.names.plural;
				version = crd.spec.versions.find((v: any) => v.served && v.storage)?.name || crd.spec.versions[0].name;
				group = crd.spec.group;
				scope = crd.spec.scope;
			} catch (err) {
				output.appendLine(`[ERROR] Could not fetch CRD details for ${crdName}: ${err}`);
				output.appendLine(`This may mean the CRD does not exist in your cluster or the name is incorrect.`);
				output.appendLine(`Try running 'kubectl get crd' to see available CRDs.`);
				return;
			}

			// Always use CRD's plural, group, and version for the API path
			let path: string;
			if (scope === 'Namespaced' && resource.namespace) {
				path = `/apis/${group}/${version}/namespaces/${resource.namespace}/${plural}`;
			} else {
				path = `/apis/${group}/${version}/${plural}`;
			}
			const fieldSelector = `metadata.name=${resource.resourceName}`;

			// Utility to clean noisy fields from K8s objects before diffing
			function cleanK8sObject(obj: any): any {
				if (!obj) { return obj; }
				const copy = JSON.parse(JSON.stringify(obj));
				if (copy.metadata) {
					delete copy.metadata.managedFields;
					delete copy.metadata.resourceVersion;
					delete copy.metadata.creationTimestamp;
					delete copy.metadata.generation;
					delete copy.metadata.uid;
				}
				if (copy.status) {
					delete copy.status.conditions;
				}
				return copy;
			}

			let prevObj: any = undefined;
			// Start the watch and store the abort function
			const req = await watch.watch(
				path,
				{ fieldSelector },
				(type, obj) => {
					const cleanedObj = cleanK8sObject(obj);
					const resourceVersion = obj?.metadata?.resourceVersion || '-';
					output.appendLine(`# [${type}] event (resourceVersion: ${resourceVersion})`);
					if (type === 'ADDED') {
						output.appendLine('# Baseline diff (initial state):');
						showDiff('{}', JSON.stringify(cleanedObj), output);
						prevObj = cleanedObj;
					} else if (type === 'MODIFIED') {
						showDiff(JSON.stringify(prevObj), JSON.stringify(cleanedObj), output);
						prevObj = cleanedObj;
					} else if (type === 'DELETED') {
						output.appendLine(`# Resource deleted`);
						showDiff(JSON.stringify(prevObj), '{}', output);
						prevObj = undefined;
					}
				},
				(err) => {
					if (err && err.name !== 'AbortError') {
						output.appendLine(`[ERROR] Watch error: ${err}`);
					}
				}
			);
			const stopWatch = () => {
				req.abort();
				output.appendLine('[INFO] Field Watch stopped.');
				fieldWatchMap.delete(resourceKey);
				fieldWatchOutputMap.delete(resourceKey);
				output.dispose(); // Close the OutputChannel tab
			};
			fieldWatchMap.set(resourceKey, stopWatch);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.stopFieldWatch', async (resource: CrossplaneResource) => {
			const resourceKey = `${resource.resourceType}:${resource.namespace || ''}:${resource.resourceName}`;
			const stopFn = fieldWatchMap.get(resourceKey);
			if (stopFn) {
				stopFn();
			} else {
				vscode.window.showInformationMessage('No active Field Watch for this resource.');
				setFieldWatchContext(resourceKey, false);
			}
		})
	);

	function showDiff(oldStr: string, newStr: string, output: vscode.OutputChannel) {
		const oldObj = yaml.load(oldStr) || {};
		const newObj = yaml.load(newStr) || {};
		const differences: DeepDiff<any, any>[] | undefined = deepDiff(oldObj, newObj);

		if (!differences || differences.length === 0) {
			return;
		}

		// Group diffs by top-level path for YAML-like output
		differences.forEach(change => {
			const pathArr = change.path || [];
			if (pathArr.length === 0) { return; }
			// Indentation: 2 spaces per level
			const indent = (level: number) => '  '.repeat(level);
			let line = '';
			if (change.kind === 'E') {
				line = `${indent(pathArr.length - 1)}${pathArr[pathArr.length - 1]}:\n${indent(pathArr.length)}~ ${JSON.stringify(change.lhs)} → ${JSON.stringify(change.rhs)}`;
			} else if (change.kind === 'N') {
				line = `${indent(pathArr.length - 1)}${pathArr[pathArr.length - 1]}:\n${indent(pathArr.length)}+ ${JSON.stringify(change.rhs)}`;
			} else if (change.kind === 'D') {
				line = `${indent(pathArr.length - 1)}${pathArr[pathArr.length - 1]}:\n${indent(pathArr.length)}- ${JSON.stringify(change.lhs)}`;
			}
			// Print parent paths if this is the first time
			if (pathArr.length > 1) {
				for (let i = 0; i < pathArr.length - 1; i++) {
					output.appendLine(`${indent(i)}${pathArr[i]}:`);
				}
			}
			output.appendLine(line);
		});
	}

	// Add helper to set context
	function setFieldWatchContext(resourceKey: string, active: boolean) {
		vscode.commands.executeCommand('setContext', `fieldWatchActive:${resourceKey}`, active);
	}
}

// This method is called when your extension is deactivated
export function deactivate() {}
