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
import fetch from 'node-fetch'; // npm install node-fetch@2
import { CrossplaneMetricsTreeProvider } from './metricsTreeProvider';
import { HelmTreeProvider } from './helmTreeProvider';

const resourceToTempFileMap = new Map<string, string>();
const tempFileToResourceMap = new Map<string, string>();
const openingResources = new Set<string>();

// Map to track output channel to process
const logProcessMap = new WeakMap<vscode.OutputChannel, any>();

// Add at the top:
const fieldWatchMap = new Map<string, () => void>();
const fieldWatchOutputMap = new Map<string, vscode.OutputChannel>();

// Add at the top of the file, after imports:
const activeLogChannels = new Set<vscode.OutputChannel>();

// Module-level variable to persist the YAML Lint output channel
let yamllintOutputChannel: vscode.OutputChannel | undefined;

// Module-level variables to persist output channels for Render Test and Schema Validation
let renderTestOutputChannel: vscode.OutputChannel | undefined;
let schemaValidationOutputChannel: vscode.OutputChannel | undefined;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "crossplane-explorer" is now active!');

	const crossplaneExplorerProvider = new CrossplaneExplorerProvider();
	context.subscriptions.push(vscode.window.registerTreeDataProvider('crossplaneExplorer', crossplaneExplorerProvider));

	const helmTreeProvider = new HelmTreeProvider();
	context.subscriptions.push(vscode.window.registerTreeDataProvider('helmExplorer', helmTreeProvider));

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
                // Use <resourceType>/<resourceName> for dotted resource types (e.g., providerconfigs.azure.upbound.io)
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
                    const { stdout, stderr } = await executeCommandWithStdin('kubectl', ['apply', '-f', '-', '--server-side', '--force-conflicts'], fileContent);
                    if (stderr && (stderr.includes('forbidden') || stderr.toLowerCase().includes('permission'))) {
                        vscode.window.showErrorMessage(`Permission denied: ${stderr}`);
                        return;
                    }
                    // Optionally, verify the change by fetching the resource again
                    try {
                        const docObj = yaml.load(fileContent) as any;
                        const kind = docObj?.kind;
                        const name = docObj?.metadata?.name;
                        const namespace = docObj?.metadata?.namespace;
                        const apiVersion = docObj?.apiVersion;
                        let group = '';
                        let version = '';
                        if (apiVersion && apiVersion.includes('/')) {
                            [group, version] = apiVersion.split('/');
                        }
                        let resourceType = kind ? kind.toLowerCase() : '';
                        if (group) {
                            resourceType = `${resourceType}.${group}`;
                        }
                        const getArgs = [
                            'get', resourceType, name, '-o', 'yaml'
                        ];
                        if (namespace) {
                            getArgs.push('-n', namespace);
                        }
                        const { stdout: getOut } = await executeCommand('kubectl', getArgs);
                        const liveObj = yaml.load(getOut) as any;
                        // Simple check: compare spec blocks
                        if (docObj?.spec && liveObj?.spec && JSON.stringify(docObj.spec) !== JSON.stringify(liveObj.spec)) {
                            vscode.window.showWarningMessage('Resource was not updated as expected. You may not have sufficient permissions.');
                            return;
                        }
                    } catch (verifyErr) {
                        // Ignore verification errors, just warn
                        vscode.window.showWarningMessage('Could not verify if the resource was updated.');
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
		// Prevent duplicate log watches for the same pod
		let existingChannel: vscode.OutputChannel | undefined = undefined;
		for (const channel of activeLogChannels) {
			if (channel.name === `Logs: ${resource.resourceName}`) {
				existingChannel = channel;
				break;
			}
		}
		if (existingChannel) {
			vscode.window.showErrorMessage('A log watch for this pod is already open. Please stop the existing log watch before starting a new one.');
			existingChannel.show(true);
			return;
		}
		const outputChannel = vscode.window.createOutputChannel(`Logs: ${resource.resourceName}`);
		// Monkey-patch dispose to always clean up activeLogChannels
		const origDispose = outputChannel.dispose.bind(outputChannel);
		outputChannel.dispose = () => {
			activeLogChannels.delete(outputChannel);
			return origDispose();
		};
		activeLogChannels.add(outputChannel);
		outputChannel.show(true);
		outputChannel.appendLine('[INFO] Log stream started for this pod.');
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
		const podName = resource.resourceName;
		const disposable = vscode.Disposable.from({
			dispose: () => {
				console.log(`[DEBUG] OutputChannel dispose called for pod: ${podName}`);
				outputChannel.appendLine('[INFO] Log stream stopped for this pod.');
				const proc = logProcessMap.get(outputChannel);
				if (proc) {
					proc.kill();
					logProcessMap.delete(outputChannel);
				}
				activeLogChannels.delete(outputChannel);
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

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.pauseResource', async (resource: CrossplaneResource) => {
			if (!resource.resourceType || !resource.resourceName) {
				vscode.window.showErrorMessage('Cannot pause resource: resource type or name is missing.');
				return;
			}
			try {
				const args = [
					'annotate', resource.resourceType, resource.resourceName,
					'crossplane.io/paused=true', '--overwrite'
				];
				if (resource.namespace) {
					args.push('-n', resource.namespace);
				}
				const { stderr } = await executeCommand('kubectl', args);
				if (stderr && (stderr.includes('forbidden') || stderr.toLowerCase().includes('permission'))) {
					vscode.window.showErrorMessage(`Permission denied: ${stderr}`);
					return;
				}
				// Verify annotation
				const getArgs = [
					'get', resource.resourceType, resource.resourceName, '-o', 'json'
				];
				if (resource.namespace) {
					getArgs.push('-n', resource.namespace);
				}
				const { stdout } = await executeCommand('kubectl', getArgs);
				const obj = JSON.parse(stdout);
				const annotation = obj?.metadata?.annotations?.['crossplane.io/paused'];
				if (annotation !== 'true') {
					vscode.window.showWarningMessage('Pause annotation was not applied. You may not have sufficient permissions.');
					return;
				}
				vscode.window.showInformationMessage(`Paused ${resource.resourceType} ${resource.resourceName}`);
			} catch (err: any) {
				vscode.window.showErrorMessage(`Failed to pause resource: ${err.message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.resumeResource', async (resource: CrossplaneResource) => {
			if (!resource.resourceType || !resource.resourceName) {
				vscode.window.showErrorMessage('Cannot resume resource: resource type or name is missing.');
				return;
			}
			try {
				const args = [
					'annotate', resource.resourceType, resource.resourceName,
					'crossplane.io/paused=false', '--overwrite'
				];
				if (resource.namespace) {
					args.push('-n', resource.namespace);
				}
				const { stderr } = await executeCommand('kubectl', args);
				if (stderr && (stderr.includes('forbidden') || stderr.toLowerCase().includes('permission'))) {
					vscode.window.showErrorMessage(`Permission denied: ${stderr}`);
					return;
				}
				// Verify annotation
				const getArgs = [
					'get', resource.resourceType, resource.resourceName, '-o', 'json'
				];
				if (resource.namespace) {
					getArgs.push('-n', resource.namespace);
				}
				const { stdout } = await executeCommand('kubectl', getArgs);
				const obj = JSON.parse(stdout);
				const annotation = obj?.metadata?.annotations?.['crossplane.io/paused'];
				if (annotation !== 'false') {
					vscode.window.showWarningMessage('Resume annotation was not applied. You may not have sufficient permissions.');
					return;
				}
				vscode.window.showInformationMessage(`Resumed ${resource.resourceType} ${resource.resourceName}`);
			} catch (err: any) {
				vscode.window.showErrorMessage(`Failed to resume resource: ${err.message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplane-explorer.stopPodLog', async (resource: CrossplaneResource) => {
			let targetChannel: vscode.OutputChannel | undefined = undefined;
			for (const channel of activeLogChannels) {
				if (channel.name === `Logs: ${resource.resourceName}`) {
					targetChannel = channel;
					break;
				}
			}
			if (targetChannel) {
				console.log(`[DEBUG] Stop button clicked for pod: ${resource.resourceName}`);
				targetChannel.appendLine('[DEBUG] Stop button clicked. Disposing OutputChannel...');
				targetChannel.dispose();
			} else {
				vscode.window.showInformationMessage('No active log watch for this pod.');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.compositionInit', async (resourceOrUri: any) => {
			let targetFolder: string | undefined;
			if (resourceOrUri && resourceOrUri.fsPath) {
				targetFolder = resourceOrUri.fsPath;
			} else {
				const folders = await vscode.window.showOpenDialog({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
					title: 'Select a folder to initialize Crossplane composition files'
				});
				if (!folders || folders.length === 0) {
					vscode.window.showInformationMessage('No folder selected.');
					return;
				}
				targetFolder = folders[0].fsPath;
			}

			const path = require('path');
			const fs = require('fs');
			const templateDir = path.join(__dirname, '..', 'resources', 'templates');
			const templateFiles = [
				'composition.yaml',
				'definition.yaml',
				'function.yaml',
				'observedResources.yaml',
				'xr.yaml',
				'environmentConfig.json',
				'function-creds.yaml',
				'providers-metadata.json',
				'extraResources.yaml'
			];

			const created: string[] = [];
			const skipped: string[] = [];
			for (const filename of templateFiles) {
				const templatePath = path.join(templateDir, filename);
				if (!fs.existsSync(templatePath)) continue;
				const content = fs.readFileSync(templatePath, 'utf8');
				const destPath = path.join(targetFolder, filename);
				if (fs.existsSync(destPath)) {
					skipped.push(filename);
					continue;
				}
				fs.writeFileSync(destPath, content);
				created.push(filename);
			}

			let message = '';
			if (created.length > 0) message += `Created: ${created.join(', ')}`;
			if (skipped.length > 0) message += (message ? ' | ' : '') + `Skipped (already exist): ${skipped.join(', ')}`;
			if (!message) message = 'No files created.';
			vscode.window.showInformationMessage(message);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.renderTest', async (uri: vscode.Uri) => {
			if (!uri || !uri.fsPath) {
				vscode.window.showErrorMessage('No folder selected. Please right-click a folder to run Render Test.');
				return;
			}
			const folderPath = uri.fsPath;
			if (!renderTestOutputChannel) {
				renderTestOutputChannel = vscode.window.createOutputChannel('Crossplane Render Test');
			}
			renderTestOutputChannel.clear();
			renderTestOutputChannel.show(true);
			const output = renderTestOutputChannel;

			// Only run crossplane render and save to renderTestOutput.yaml
			const renderArgs = [
				'render',
				'xr.yaml',
				'composition.yaml',
				'function.yaml',
				'--observed-resources=observedResources.yaml',
				'--extra-resources=extraResources.yaml',
				'--context-files',
				'apiextensions.crossplane.io/environment=environmentConfig.json',
				'--function-credentials=function-creds.yaml',
				'--include-full-xr'
			];
			const renderOutputPath = path.join(folderPath, 'renderTestOutput.yaml');
			output.appendLine(`# Running: crossplane ${renderArgs.join(' ')} > renderTestOutput.yaml`);
			const cp = require('child_process');
			try {
				await new Promise<void>((resolve, reject) => {
					const renderProc = cp.spawn('crossplane', renderArgs, { cwd: folderPath });
					const outStream = fs.createWriteStream(renderOutputPath);
					renderProc.stdout.pipe(outStream);
					let stderr = '';
					renderProc.stderr.on('data', (data: Buffer) => {
						stderr += data.toString();
					});
					renderProc.on('close', (code: number) => {
						outStream.end();
						if (code === 0) {
							output.appendLine(`✅ Render completed. Output written to renderTestOutput.yaml.`);
							resolve();
						} else {
							output.appendLine(`[ERROR] crossplane render failed with code ${code}`);
							if (stderr) output.appendLine(stderr);
							reject(new Error('crossplane render failed'));
						}
					});
				});
			} catch (err: any) {
				vscode.window.showErrorMessage('Render Test failed. See output for details.');
				return;
			}
		})
	);

	// Helper to strip ANSI color codes from a string
	function stripAnsiCodes(text: string): string {
		// Regex to match ANSI escape codes
		return text.replace(/\u001b\[[0-9;]*m/g, '');
	}

	// Helper to replace validation symbols with emoji
	function replaceValidationSymbols(text: string): string {
		return text
			.replace(/\[✓\]/g, '✅')
			.replace(/\[!\]/g, '⚠️')
			.replace(/\[x\]/gi, '❌');
	}

	// Helper to add emoji to summary line
	function summaryWithEmoji(line: string): string {
		const match = line.match(/Total (\d+) resources: (\d+) missing schemas, (\d+) success cases, (\d+) failure cases/);
		if (!match) return line;
		const total = parseInt(match[1], 10);
		const missing = parseInt(match[2], 10);
		const success = parseInt(match[3], 10);
		const failure = parseInt(match[4], 10);
		if (total === success && missing === 0 && failure === 0) {
			return `✅ ${line}`;
		} else if (failure > 0) {
			return `❌ ${line}`;
		} else if (missing > 0) {
			return `⚠️ ${line}`;
		}
		return line;
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.schemaValidation', async (uri: vscode.Uri) => {
			if (!uri || !uri.fsPath) {
				vscode.window.showErrorMessage('No folder selected. Please right-click a folder to run Schema Validation.');
				return;
			}
			const folderPath = uri.fsPath;
			if (!schemaValidationOutputChannel) {
				schemaValidationOutputChannel = vscode.window.createOutputChannel('Crossplane Schema Validation');
			}
			schemaValidationOutputChannel.clear();
			schemaValidationOutputChannel.show(true);
			const output = schemaValidationOutputChannel;

			// Download and merge CRDs
			await downloadAndMergeCrds(folderPath, output);

			// Validate with crossplane beta validate
			const crdsPath = path.join(folderPath, 'schema', 'downloaded-crds.yaml');
			const renderOutputPath = path.join(folderPath, 'renderTestOutput.yaml');
			const relCrdsPath = path.relative(folderPath, crdsPath);
			const relRenderOutputPath = path.relative(folderPath, renderOutputPath);
			output.appendLine(`# Validating: crossplane beta validate ${relCrdsPath} ${relRenderOutputPath}`);
			const cp = require('child_process');
			const stripAnsi = (await import('strip-ansi')).default;
			try {
				await new Promise<void>((resolve, reject) => {
					const validateProc = cp.spawn('crossplane', ['beta', 'validate', crdsPath, renderOutputPath], { cwd: folderPath });
					let stdout = '';
					let stderr = '';
					validateProc.stdout.on('data', (data: Buffer) => {
						stdout += data.toString();
					});
					validateProc.stderr.on('data', (data: Buffer) => {
						stderr += data.toString();
					});
					validateProc.on('close', async (code: number) => {
						// Print validation results, then a blank line, then the summary
						if (stdout) {
							const lines = stdout.split('\n');
							for (const line of lines) {
								if (line.match(/Total \d+ resources: \d+ missing schemas, \d+ success cases, \d+ failure cases/)) {
									output.appendLine(stripAnsi(summaryWithEmoji(line)));
								} else if (line.match(/\[✓\]|\[!\]|\[x\]/i)) {
									const replaced = replaceValidationSymbols(stripAnsiCodes(line));
									if (replaced.match(/^(✅|⚠️|❌)/)) {
										output.appendLine(stripAnsi(`\t${replaced}`));
									} else {
										output.appendLine(stripAnsi(replaced));
									}
								} else if (line.trim() !== '') {
									output.appendLine(stripAnsi(line));
								}
							}
							output.appendLine(''); // Blank line before summary
						}
						if (stderr) output.appendLine(stripAnsi(stderr));
						if (code === 0) {
							output.appendLine(stripAnsi('✅ Validation succeeded.'));
							resolve();
						} else {
							output.appendLine(stripAnsi(`[ERROR] crossplane beta validate failed with code ${code}`));
							reject(new Error('crossplane beta validate failed'));
						}
					});
				});
			} catch (err: any) {
				vscode.window.showErrorMessage('Schema Validation failed. See output for details.');
			}
		})
	);

	// Helper to update provider or function runtimeConfigRef.name
	async function updateProviderOrFunctionRuntimeConfig(resource: any, debug: boolean) {
		const isProvider = resource.contextValue === 'provider' || resource.resourceType === 'provider' || resource.resourceType === 'providers';
		const isFunction = resource.contextValue === 'function' || resource.resourceType === 'function' || resource.resourceType === 'functions' || resource.resourceType === 'functions.pkg.crossplane.io';
		if (!resource || (!isProvider && !isFunction)) {
			vscode.window.showErrorMessage('This action can only be performed on provider or function objects.');
			return;
		}
		try {
			// Determine resource kind and type
			let kind = isProvider ? 'provider' : 'functions.pkg.crossplane.io';
			let getCmd = ['get', kind, resource.resourceName, '-o', 'yaml'];
			if (resource.namespace) {
				getCmd.push('-n', resource.namespace);
			}
			const { stdout } = await executeCommand('kubectl', getCmd);

			const obj = yaml.load(stdout) as any;
			if (!obj || typeof obj !== 'object') {
				vscode.window.showErrorMessage('Failed to parse resource YAML.');
				return;
			}
			if (!obj['spec']) obj['spec'] = {};
			if (!obj['spec']['runtimeConfigRef']) {
				obj['spec']['runtimeConfigRef'] = {
					apiVersion: 'pkg.crossplane.io/v1beta1',
					kind: 'DeploymentRuntimeConfig',
					name: debug ? 'enable-debug' : 'default'
				};
			} else {
				obj['spec']['runtimeConfigRef']['name'] = debug ? 'enable-debug' : 'default';
			}

			const updatedYaml = yaml.dump(obj);
			const { exec } = require('child_process');
			const apply = exec('kubectl apply -f -', (err: any, stdout: string, stderr: string) => {
				if (err) {
					vscode.window.showErrorMessage(`Failed to ${debug ? 'enable' : 'disable'} debug mode. See output for details.`);
					console.error(stderr || err.message);
					return;
				}
				vscode.window.showInformationMessage(`Debug mode ${debug ? 'enabled' : 'disabled'} for ${isProvider ? 'provider' : 'function'}.`);
			});
			apply.stdin.write(updatedYaml);
			apply.stdin.end();
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to ${debug ? 'enable' : 'disable'} debug mode: ${err.message}`);
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.enableDebugMode', async (resource: any) => {
			const isProvider = resource.contextValue === 'provider' || resource.resourceType === 'provider' || resource.resourceType === 'providers';
			const resourceType = isProvider ? 'provider' : 'function';
			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to enable debug mode for ${resourceType} "${resource.resourceName}"?\n\nThis will restart the underlying pod and may cause a brief service interruption.`,
				{ modal: true },
				'Enable Debug Mode'
			);
			if (confirm !== 'Enable Debug Mode') return;
			await updateProviderOrFunctionRuntimeConfig(resource, true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.disableDebugMode', async (resource: any) => {
			const isProvider = resource.contextValue === 'provider' || resource.resourceType === 'provider' || resource.resourceType === 'providers';
			const resourceType = isProvider ? 'provider' : 'function';
			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to disable debug mode for ${resourceType} "${resource.resourceName}"?\n\nThis will restart the underlying pod and may cause a brief service interruption.`,
				{ modal: true },
				'Disable Debug Mode'
			);
			if (confirm !== 'Disable Debug Mode') return;
			await updateProviderOrFunctionRuntimeConfig(resource, false);
		})
	);

	// Helper to get pod name for provider or function
	async function getPodNameForProviderOrFunction(resource: any): Promise<{ podName: string; namespace: string } | null> {
		const isProvider = resource.contextValue === 'provider' || resource.resourceType === 'provider' || resource.resourceType === 'providers';
		const isFunction = resource.contextValue === 'function' || resource.resourceType === 'function' || resource.resourceType === 'functions' || resource.resourceType === 'functions.pkg.crossplane.io';
		
		if (!resource || (!isProvider && !isFunction)) {
			vscode.window.showErrorMessage('This action can only be performed on provider or function objects.');
			return null;
		}

		try {
			// Get the provider/function to find its pod
			let kind = isProvider ? 'provider' : 'functions.pkg.crossplane.io';
			let getCmd = ['get', kind, resource.resourceName, '-o', 'json'];
			if (resource.namespace) {
				getCmd.push('-n', resource.namespace);
			}
			const { stdout } = await executeCommand('kubectl', getCmd);
			const obj = JSON.parse(stdout);

			// Find the pod using labels
			const labelSelector = isProvider ? 'pkg.crossplane.io/provider' : 'pkg.crossplane.io/function';
			const podCmd = ['get', 'pods', '--all-namespaces', '-l', labelSelector, '-o', 'json'];
			const { stdout: podsStdout } = await executeCommand('kubectl', podCmd);
			const pods = JSON.parse(podsStdout);

			// Find the pod that belongs to this specific provider/function
			const targetPod = pods.items.find((pod: any) => {
				const podLabels = pod.metadata.labels || {};
				if (isProvider) {
					// For providers, check if the pod name contains the provider name
					return pod.metadata.name.includes(resource.resourceName.toLowerCase());
				} else {
					// For functions, check if the pod name contains the function name
					return pod.metadata.name.includes(resource.resourceName.toLowerCase());
				}
			});

			if (!targetPod) {
				vscode.window.showErrorMessage(`No pod found for ${isProvider ? 'provider' : 'function'} ${resource.resourceName}`);
				return null;
			}

			return {
				podName: targetPod.metadata.name,
				namespace: targetPod.metadata.namespace
			};
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to find pod: ${err.message}`);
			return null;
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.restartPod', async (resource: any) => {
			// Support direct pod restart for crossplane-pod context
			if (resource.contextValue === 'crossplane-pod') {
				const podName = resource.resourceName;
				const namespace = resource.namespace;
				if (!podName || !namespace) {
					vscode.window.showErrorMessage('Pod name or namespace missing.');
					return;
				}
				const restart = await vscode.window.showWarningMessage(
					`Are you sure you want to restart the pod "${podName}" in namespace "${namespace}"?\n\nThis will cause a brief interruption in service.`,
					{ modal: true },
					'Restart Pod'
				);
				if (restart !== 'Restart Pod') return;
				try {
					const { stderr } = await executeCommand('kubectl', [
						'delete', 'pod', podName, '-n', namespace
					]);
					if (stderr && !stderr.includes('deleted')) {
						vscode.window.showErrorMessage(`Failed to restart pod: ${stderr}`);
						return;
					}
					vscode.window.showInformationMessage(`Successfully restarted pod "${podName}" in namespace "${namespace}"`);
				} catch (err: any) {
					vscode.window.showErrorMessage(`Failed to restart pod: ${err.message}`);
				}
				return;
			}
			const podInfo = await getPodNameForProviderOrFunction(resource);
			if (!podInfo) return;

			const isProvider = resource.contextValue === 'provider' || resource.resourceType === 'provider' || resource.resourceType === 'providers';
			const resourceType = isProvider ? 'provider' : 'function';
			
			// Show confirmation dialog
			const restart = await vscode.window.showWarningMessage(
				`Are you sure you want to restart the pod for ${resourceType} "${resource.resourceName}"?\n\nPod: ${podInfo.podName} (${podInfo.namespace})\n\nThis will cause a brief interruption in service.`,
				{ modal: true },
				'Restart Pod'
			);

			if (restart !== 'Restart Pod') {
				return;
			}

			try {
				// Delete the pod to restart it (Kubernetes will recreate it)
				const { stderr } = await executeCommand('kubectl', [
					'delete', 'pod', podInfo.podName, '-n', podInfo.namespace
				]);

				if (stderr && !stderr.includes('deleted')) {
					vscode.window.showErrorMessage(`Failed to restart pod: ${stderr}`);
					return;
				}

				vscode.window.showInformationMessage(`Successfully restarted pod for ${resourceType} "${resource.resourceName}"`);
			} catch (err: any) {
				vscode.window.showErrorMessage(`Failed to restart pod: ${err.message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.killPod', async (resource: any) => {
			// Support direct pod kill for crossplane-pod context
			if (resource.contextValue === 'crossplane-pod') {
				const podName = resource.resourceName;
				const namespace = resource.namespace;
				if (!podName || !namespace) {
					vscode.window.showErrorMessage('Pod name or namespace missing.');
					return;
				}
				const kill = await vscode.window.showWarningMessage(
					`Are you sure you want to KILL the pod "${podName}" in namespace "${namespace}"?\n\n⚠️  WARNING: This will permanently delete the pod. The pod will be recreated by the deployment, but any local data will be lost.`,
					{ modal: true },
					'Kill Pod'
				);
				if (kill !== 'Kill Pod') return;
				try {
					const { stderr } = await executeCommand('kubectl', [
						'delete', 'pod', podName, '-n', namespace, '--force', '--grace-period=0'
					]);
					if (stderr && !stderr.includes('deleted')) {
						vscode.window.showErrorMessage(`Failed to kill pod: ${stderr}`);
						return;
					}
					vscode.window.showInformationMessage(`Successfully killed pod "${podName}" in namespace "${namespace}"`);
				} catch (err: any) {
					vscode.window.showErrorMessage(`Failed to kill pod: ${err.message}`);
				}
				return;
			}
			const podInfo = await getPodNameForProviderOrFunction(resource);
			if (!podInfo) return;

			const isProvider = resource.contextValue === 'provider' || resource.resourceType === 'provider' || resource.resourceType === 'providers';
			const resourceType = isProvider ? 'provider' : 'function';
			
			// Show confirmation dialog
			const kill = await vscode.window.showWarningMessage(
				`Are you sure you want to KILL the pod for ${resourceType} "${resource.resourceName}"?\n\nPod: ${podInfo.podName} (${podInfo.namespace})\n\n⚠️  WARNING: This will permanently delete the pod. The pod will be recreated by the deployment, but any local data will be lost.`,
				{ modal: true },
				'Kill Pod'
			);

			if (kill !== 'Kill Pod') {
				return;
			}

			try {
				// Force delete the pod
				const { stderr } = await executeCommand('kubectl', [
					'delete', 'pod', podInfo.podName, '-n', podInfo.namespace, '--force', '--grace-period=0'
				]);

				if (stderr && !stderr.includes('deleted')) {
					vscode.window.showErrorMessage(`Failed to kill pod: ${stderr}`);
					return;
				}

				vscode.window.showInformationMessage(`Successfully killed pod for ${resourceType} "${resource.resourceName}"`);
			} catch (err: any) {
				vscode.window.showErrorMessage(`Failed to kill pod: ${err.message}`);
			}
		})
	);

	// Helper to safely delete 'enable-debug' DeploymentRuntimeConfig if not referenced
	async function safeDeleteEnableDebugConfig() {
		try {
			// 1. Get all providers
			const { stdout: providersOut } = await executeCommand('kubectl', ['get', 'provider', '-o', 'json']);
			const providers = JSON.parse(providersOut).items || [];
			// 2. Get all functions
			let functions: any[] = [];
			try {
				const { stdout: functionsOut } = await executeCommand('kubectl', ['get', 'functions.pkg.crossplane.io', '-o', 'json']);
				functions = JSON.parse(functionsOut).items || [];
			} catch {}
			// 3. Check for any reference to 'enable-debug'
			const referenced = [...providers, ...functions].some(item =>
				item?.spec?.runtimeConfigRef?.name === 'enable-debug'
			);
			if (referenced) {
				vscode.window.showWarningMessage('Cannot delete "enable-debug" DeploymentRuntimeConfig: it is still referenced by a Provider or Function.');
				return;
			}
			// 4. Delete the object
			const { exec } = require('child_process');
			exec('kubectl delete deploymentruntimeconfig enable-debug', (err: any, stdout: string, stderr: string) => {
				if (err) {
					vscode.window.showErrorMessage('Failed to delete enable-debug DeploymentRuntimeConfig. See output for details.');
					console.error(stderr || err.message);
					return;
				}
				vscode.window.showInformationMessage('enable-debug DeploymentRuntimeConfig deleted.');
			});
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to check or delete enable-debug config: ${err.message}`);
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.deleteEnableDebugConfig', async () => {
			await safeDeleteEnableDebugConfig();
		})
	);

	async function downloadAndMergeCrds(folderPath: string, outputChannel: vscode.OutputChannel) {
		const jsonFile = path.join(folderPath, 'providers-metadata.json');
		const schemaDir = path.join(folderPath, 'schema');
		const outputFile = path.join(schemaDir, 'downloaded-crds.yaml');
		if (!fs.existsSync(jsonFile)) {
			outputChannel.appendLine('❌ providers-metadata.json not found in the selected folder.');
			return;
		}
		if (!fs.existsSync(schemaDir)) {
			fs.mkdirSync(schemaDir);
		}
		if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

		const crdsJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
		let githubOrg: string = crdsJson.githubOrg.replace(/\/+$/, '');

		for (const provider of crdsJson.providers) {
			const { name, version, kinds } = provider;
			outputChannel.appendLine(`🔍 Downloading CRDs for ${name} (${version})...`);
			let successCount = 0;
			let failed: string[] = [];
			for (const kind of kinds) {
				let crdFilename: string;
				if (kind.includes('_')) {
					crdFilename = `${kind}.yaml`;
				} else {
					const plural = kind.split('.')[0];
					const group = kind.split('.').slice(1).join('.');
					crdFilename = `${group}_${plural}.yaml`;
				}
				const rawUrl = `${githubOrg}/${name}/${version}/package/crds/${crdFilename}`;
				try {
					const res = await fetch(rawUrl);
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					let content = await res.text();
					content = content.replace(/^---\n?/, ''); // Remove leading '---'
					fs.appendFileSync(outputFile, `---\n${content}\n`);
					successCount++;
				} catch (err) {
					failed.push(`${crdFilename} (${kind})`);
				}
			}
			outputChannel.appendLine(`✅ Downloaded ${successCount} CRDs for ${name} (${version})`);
			if (failed.length > 0) {
				outputChannel.appendLine(`❌ Failed to download for ${name}:`);
				failed.forEach(f => outputChannel.appendLine(`   - ${f}`));
			}
		}
		// Append definition.yaml if it exists
		const definitionPath = path.join(folderPath, 'definition.yaml');
		if (fs.existsSync(definitionPath)) {
			const defContent = fs.readFileSync(definitionPath, 'utf8');
			fs.appendFileSync(outputFile, `---\n${defContent}\n`);
			const relOutputFile = path.relative(folderPath, outputFile);
			outputChannel.appendLine(`📄 Appended definition.yaml to: ${relOutputFile}`);
		}
		const relOutputFile = path.relative(folderPath, outputFile);
		outputChannel.appendLine(`📦 All CRDs merged into: ${relOutputFile}`);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.deployComposition', async (uri: vscode.Uri) => {
			if (!uri || !uri.fsPath) {
				vscode.window.showErrorMessage('No folder selected. Please right-click a folder to run Deploy.');
				return;
			}
			const folderPath = uri.fsPath;
			const output = vscode.window.createOutputChannel('Crossplane Deploy');
			output.show(true);

			// Confirmation dialog
			const confirm = await vscode.window.showWarningMessage(
				'Are you sure you want to deploy? This will apply definition.yaml and then composition.yaml to the cluster (in that order).',
				{ modal: true },
				'Deploy'
			);
			if (confirm !== 'Deploy') return;

			const path = require('path');
			const fs = require('fs');
			const defPath = path.join(folderPath, 'definition.yaml');
			const compPath = path.join(folderPath, 'composition.yaml');

			// Check if files exist
			if (!fs.existsSync(defPath)) {
				vscode.window.showErrorMessage('definition.yaml not found in the selected folder.');
				output.appendLine('❌ definition.yaml not found.');
				return;
			}
			if (!fs.existsSync(compPath)) {
				vscode.window.showErrorMessage('composition.yaml not found in the selected folder.');
				output.appendLine('❌ composition.yaml not found.');
				return;
			}

			// Apply definition.yaml
			output.appendLine(`# Applying: kubectl apply -f definition.yaml`);
			const { executeCommand } = require('./utils');
			try {
				const defResult = await executeCommand('kubectl', ['apply', '-f', defPath]);
				output.appendLine(defResult.stdout);
				if (defResult.stderr) output.appendLine(defResult.stderr);
				vscode.window.showInformationMessage('definition.yaml applied successfully.');
			} catch (err) {
				output.appendLine(`❌ Failed to apply definition.yaml: ${(err as any).message}`);
				vscode.window.showErrorMessage(`Failed to apply definition.yaml: ${(err as any).message}`);
				return;
			}

			// Apply composition.yaml
			output.appendLine(`# Applying: kubectl apply -f composition.yaml`);
			try {
				const compResult = await executeCommand('kubectl', ['apply', '-f', compPath]);
				output.appendLine(compResult.stdout);
				if (compResult.stderr) output.appendLine(compResult.stderr);
				vscode.window.showInformationMessage('composition.yaml applied successfully.');
			} catch (err) {
				output.appendLine(`❌ Failed to apply composition.yaml: ${(err as any).message}`);
				vscode.window.showErrorMessage(`Failed to apply composition.yaml: ${(err as any).message}`);
				return;
			}

			// Apply xr.yaml (if it exists)
			const xrPath = path.join(folderPath, 'xr.yaml');
			if (fs.existsSync(xrPath)) {
				output.appendLine(`# Applying: kubectl apply -f xr.yaml`);
				try {
					const xrResult = await executeCommand('kubectl', ['apply', '-f', xrPath]);
					output.appendLine(xrResult.stdout);
					if (xrResult.stderr) output.appendLine(xrResult.stderr);
					vscode.window.showInformationMessage('xr.yaml applied successfully.');
				} catch (err) {
					output.appendLine(`❌ Failed to apply xr.yaml: ${(err as any).message}`);
					vscode.window.showErrorMessage(`Failed to apply xr.yaml: ${(err as any).message}`);
					return;
				}
			} else {
				output.appendLine('ℹ️ xr.yaml not found, skipping.');
			}

			output.appendLine('✅ Deploy completed.');
			vscode.window.showInformationMessage('Deploy completed: definition.yaml, composition.yaml, and (if present) xr.yaml applied.');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.undeployComposition', async (uri: vscode.Uri) => {
			if (!uri || !uri.fsPath) {
				vscode.window.showErrorMessage('No folder selected. Please right-click a folder to run UnDeploy.');
				return;
			}
			const folderPath = uri.fsPath;
			const output = vscode.window.createOutputChannel('Crossplane UnDeploy');
			output.show(true);

			// Confirmation dialog with strong warning
			const confirm = await vscode.window.showWarningMessage(
				'Are you sure you want to UNDEPLOY? This will delete xr.yaml (if present), then composition.yaml, then definition.yaml from the cluster (in that order).\n\n⚠️ WARNING: Make sure you have checked the cluster and that the definition in this folder is not being used by any other XRs. This action is irreversible.',
				{ modal: true },
				'UnDeploy'
			);
			if (confirm !== 'UnDeploy') return;

			const path = require('path');
			const fs = require('fs');
			const { executeCommand } = require('./utils');

			// Delete xr.yaml (if it exists)
			const xrPath = path.join(folderPath, 'xr.yaml');
			if (fs.existsSync(xrPath)) {
				output.appendLine(`# Deleting: kubectl delete -f xr.yaml`);
				try {
					const xrResult = await executeCommand('kubectl', ['delete', '-f', xrPath]);
					output.appendLine(xrResult.stdout);
					if (xrResult.stderr) output.appendLine(xrResult.stderr);
					vscode.window.showInformationMessage('xr.yaml deleted successfully.');
				} catch (err) {
					output.appendLine(`❌ Failed to delete xr.yaml: ${(err as any).message}`);
					vscode.window.showErrorMessage(`Failed to delete xr.yaml: ${(err as any).message}`);
					return;
				}
			} else {
				output.appendLine('ℹ️ xr.yaml not found, skipping.');
			}

			// Delete composition.yaml
			const compPath = path.join(folderPath, 'composition.yaml');
			if (fs.existsSync(compPath)) {
				output.appendLine(`# Deleting: kubectl delete -f composition.yaml`);
				try {
					const compResult = await executeCommand('kubectl', ['delete', '-f', compPath]);
					output.appendLine(compResult.stdout);
					if (compResult.stderr) output.appendLine(compResult.stderr);
					vscode.window.showInformationMessage('composition.yaml deleted successfully.');
				} catch (err) {
					output.appendLine(`❌ Failed to delete composition.yaml: ${(err as any).message}`);
					vscode.window.showErrorMessage(`Failed to delete composition.yaml: ${(err as any).message}`);
					return;
				}
			} else {
				output.appendLine('❌ composition.yaml not found.');
				vscode.window.showErrorMessage('composition.yaml not found in the selected folder.');
				return;
			}

			// Delete definition.yaml
			const defPath = path.join(folderPath, 'definition.yaml');
			if (fs.existsSync(defPath)) {
				output.appendLine(`# Deleting: kubectl delete -f definition.yaml`);
				try {
					const defResult = await executeCommand('kubectl', ['delete', '-f', defPath]);
					output.appendLine(defResult.stdout);
					if (defResult.stderr) output.appendLine(defResult.stderr);
					vscode.window.showInformationMessage('definition.yaml deleted successfully.');
				} catch (err) {
					output.appendLine(`❌ Failed to delete definition.yaml: ${(err as any).message}`);
					vscode.window.showErrorMessage(`Failed to delete definition.yaml: ${(err as any).message}`);
					return;
				}
			} else {
				output.appendLine('❌ definition.yaml not found.');
				vscode.window.showErrorMessage('definition.yaml not found in the selected folder.');
				return;
			}

			output.appendLine('✅ UnDeploy completed.');
			vscode.window.showInformationMessage('UnDeploy completed: xr.yaml (if present), composition.yaml, and definition.yaml deleted.');
		})
	);

	// Register the metrics tree view
	const metricsProvider = new CrossplaneMetricsTreeProvider();
	const metricsTreeView = vscode.window.createTreeView('crossplaneMetricsTree', {
		treeDataProvider: metricsProvider
	});
	context.subscriptions.push(metricsTreeView);
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('crossplaneMetricsTree', metricsProvider)
	);

	// Register the monitor duration command for the Performance panel
	context.subscriptions.push(vscode.commands.registerCommand('crossplane-metrics.setMonitorDuration', async (provider: any) => {
		const pick = await vscode.window.showQuickPick(['1', '5', '15', '30'], { placeHolder: 'Select monitoring duration (minutes)' });
		if (pick) provider.setMonitorDuration(Number(pick));
	}));

	// Register the stop monitoring command for the Performance panel
	context.subscriptions.push(vscode.commands.registerCommand('crossplane-metrics.stopMonitoring', (provider: any) => {
		provider.stopMonitoring();
	}));

	// Start/stop metrics fetchers only on expand/collapse
	metricsTreeView.onDidExpandElement(e => {
		if (e.element.label === 'Crossplane') {
			metricsProvider.startCrossplaneMetrics();
		}
		if (e.element.label === 'Cluster') {
			metricsProvider.startClusterMetrics();
		}
	});
	metricsTreeView.onDidCollapseElement(e => {
		if (e.element.label === 'Crossplane') {
			metricsProvider.stopCrossplaneMetrics();
		}
		if (e.element.label === 'Cluster') {
			metricsProvider.stopClusterMetrics();
		}
	});

	context.subscriptions.push(vscode.commands.registerCommand('crossplane-explorer.deleteResource', async (resource: CrossplaneResource) => {
		if (!resource || !resource.resourceType || !resource.resourceName) {
			vscode.window.showErrorMessage('Cannot delete: resource type or name missing.');
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Are you sure you want to delete ${resource.resourceType} '${resource.resourceName}'? This action cannot be undone.`,
			{ modal: true },
			'Delete'
		);
		if (confirm !== 'Delete') return;
		try {
			let deleteArgs: string[];
			if (resource.resourceType === 'xrd') {
				deleteArgs = ['delete', 'xrd', resource.resourceName];
			} else if (resource.resourceType === 'crd') {
				deleteArgs = ['delete', 'crd', resource.resourceName];
			} else {
				deleteArgs = ['delete', resource.resourceType, resource.resourceName];
				if (resource.namespace) {
					deleteArgs.push('-n', resource.namespace);
				}
			}
			const { stdout, stderr } = await executeCommand('kubectl', deleteArgs);
			if (stderr && !stdout) {
				vscode.window.showErrorMessage(stderr);
				return;
			}
			vscode.window.showInformationMessage(`${resource.resourceType} '${resource.resourceName}' deleted.`);
			crossplaneExplorerProvider.refresh();
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to delete: ${err.message}`);
		}
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('crossplaneExplorer.yamllint', async (uri: vscode.Uri) => {
			if (!uri || !uri.fsPath) {
				vscode.window.showErrorMessage('No folder selected. Please right-click a folder to run YAML Lint.');
				return;
			}
			const folderPath = uri.fsPath;
			const config = vscode.workspace.getConfiguration('crossplaneExplorer');
			const dockerImage = config.get<string>('yamllintDockerImage', 'registry.gitlab.com/pipeline-components/yamllint:latest');
			if (!yamllintOutputChannel) {
				yamllintOutputChannel = vscode.window.createOutputChannel('YAML Lint');
			}
			yamllintOutputChannel!.clear();
			yamllintOutputChannel!.show(true);
			yamllintOutputChannel!.appendLine(`YAML Lint`);
			yamllintOutputChannel!.appendLine(`✅ Pulling image: ${dockerImage}`);
			yamllintOutputChannel!.appendLine(`✅ Running yamllint on composition.yaml and definition.yaml\n`);

			const filesToLint = ['composition.yaml', 'definition.yaml']
				.map(f => require('path').join(folderPath, f))
				.filter(require('fs').existsSync);
			if (filesToLint.length === 0) {
				yamllintOutputChannel!.appendLine('No composition.yaml or definition.yaml found in the selected folder.');
				return;
			}

			const filesArg = filesToLint.map(f => `/code/${require('path').basename(f)}`).join(' ');
			const cmd = `docker run --rm -v "${folderPath}:/code" ${dockerImage} yamllint ${filesArg}`;
			yamllintOutputChannel!.appendLine(`$ ${cmd}\n`);

			const cp = require('child_process');
			cp.exec(cmd, { cwd: folderPath }, (err: any, stdout: string, stderr: string) => {
				let message = '';
				let isSuccess = false;
				if (!stdout && !stderr) {
					yamllintOutputChannel!.appendLine('✅ yamllint: composition.yaml and definition.yaml meet YAML syntax and style standards.');
					message = 'yamllint: composition.yaml and definition.yaml meet YAML syntax and style standards.';
					isSuccess = true;
				} else {
					if (stdout) yamllintOutputChannel!.appendLine(stdout);
					if (stderr) yamllintOutputChannel!.appendLine(stderr);
					if (err) {
						if (stderr && stderr.includes('docker: command not found')) {
							message = 'Docker is not installed or not available in PATH. Please install Docker to use YAML Lint.';
						} else {
							message = 'YAML Lint completed with errors. See output for details.';
						}
					} else {
						message = 'YAML Lint completed. See output for details.';
					}
				}

				// Show notification with a 'Close Output' button
				vscode.window.showInformationMessage(message, 'Close Output').then(selection => {
					if (selection === 'Close Output') {
						yamllintOutputChannel!.dispose();
					}
				});

				// Auto-close after 2 minutes if not already closed
				setTimeout(() => {
					if ((yamllintOutputChannel as any)._disposed !== true) {
						yamllintOutputChannel!.dispose();
					}
				}, 2 * 60 * 1000);
			});
		})
	);

	// Add a status bar button for 'Apply'
	const applyStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	applyStatusBarItem.text = '$(cloud-upload) kapply';
	applyStatusBarItem.tooltip = 'kubectl apply -f <current YAML file> (kapply)';
	applyStatusBarItem.command = 'crossplaneExplorer.applyCurrentYaml';
	applyStatusBarItem.show();
	context.subscriptions.push(applyStatusBarItem);

	// Add a status bar button for 'Delete'
	const deleteStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	deleteStatusBarItem.text = '$(trash) kdelete';
	deleteStatusBarItem.tooltip = 'kubectl delete -f <current YAML file> (kdelete)';
	deleteStatusBarItem.command = 'crossplaneExplorer.deleteCurrentYaml';
	deleteStatusBarItem.show();
	context.subscriptions.push(deleteStatusBarItem);

	context.subscriptions.push(vscode.commands.registerCommand('crossplaneExplorer.applyCurrentYaml', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !editor.document || !editor.document.fileName.endsWith('.yaml')) {
			vscode.window.showWarningMessage('No YAML file is currently open.');
			return;
		}
		const filePath = editor.document.fileName;
		const cp = require('child_process');
		cp.exec(`kubectl apply -f "${filePath}"`, (err: any, stdout: string, stderr: string) => {
			if (err) {
				vscode.window.showErrorMessage(`kubectl apply failed: ${stderr || err.message}`);
			} else {
				let message = `Successfully applied: ${filePath}`;
				if (stdout && stdout.trim().length > 0) {
					message += `\n${stdout.trim()}`;
				}
				vscode.window.showInformationMessage(message);
			}
		});
	}));

	context.subscriptions.push(vscode.commands.registerCommand('crossplaneExplorer.deleteCurrentYaml', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !editor.document || !editor.document.fileName.endsWith('.yaml')) {
			vscode.window.showWarningMessage('No YAML file is currently open.');
			return;
		}
		const filePath = editor.document.fileName;
		const cp = require('child_process');
		cp.exec(`kubectl delete -f "${filePath}"`, (err: any, stdout: string, stderr: string) => {
			console.log('[kdelete callback]', { err, stdout, stderr }); // Debug log
			if (err) {
				vscode.window.showErrorMessage(`kubectl delete failed: ${stderr || err.message}`);
			} else {
				let message = `Successfully deleted: ${filePath}`;
				if (stdout && stdout.trim().length > 0) {
					message += `\n${stdout.trim()}`;
				} else if (stderr && stderr.trim().length > 0) {
					message += `\n${stderr.trim()}`;
				} else {
					message += '\n(kubectl returned no output)';
				}
				vscode.window.showInformationMessage(message);
			}
		});
	}));

	// Helm Explorer Commands
	context.subscriptions.push(vscode.commands.registerCommand('helm-explorer.refreshReleases', () => {
		helmTreeProvider.refreshReleases();
	}));


	context.subscriptions.push(vscode.commands.registerCommand('helm-explorer.viewRelease', async (item: any) => {
		if (!item || !item.release) {
			vscode.window.showErrorMessage('No release selected');
			return;
		}
		const release = item.release;
		
		// Show enhanced markdown view with syntax highlighting
		await showEnhancedHelmReleaseDetails(release, helmTreeProvider);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('helm-explorer.uninstallRelease', async (item: any) => {
		console.log('=== HELM UNINSTALL COMMAND STARTED ===');
		console.log('helm-explorer.uninstallRelease called with item:', item);
		
		if (!item || !item.release) {
			console.log('ERROR: No release selected');
			vscode.window.showErrorMessage('No release selected');
			return;
		}
		
		const release = item.release;
		console.log('Release to uninstall:', release);
		console.log('About to show confirmation dialog...');
		
		try {
			// Use showInformationMessage with modal - let VS Code provide the default Cancel
			console.log('Displaying confirmation dialog...');
			const confirm = await vscode.window.showInformationMessage(
				`Are you sure you want to uninstall Helm release "${release.name}" in namespace "${release.namespace}"?`,
				{ modal: true },
				'Yes, Uninstall'
			);
			console.log('User confirmation result:', confirm);
			
			if (confirm === 'Yes, Uninstall') {
				console.log('User confirmed uninstall - calling helmTreeProvider.uninstallRelease...');
				await helmTreeProvider.uninstallRelease(release);
				console.log('helmTreeProvider.uninstallRelease completed');
			} else {
				// undefined (dismissed) should be treated as cancellation
				console.log('User cancelled or dismissed uninstall dialog');
			}
		} catch (error) {
			console.log('ERROR in uninstall command:', error);
			vscode.window.showErrorMessage(`Error in uninstall command: ${error}`);
		}
		
		console.log('=== HELM UNINSTALL COMMAND ENDED ===');
	}));


	context.subscriptions.push(vscode.commands.registerCommand('helm-explorer.rollbackRelease', async (item: any) => {
		console.log('=== HELM ROLLBACK COMMAND STARTED ===');
		console.log('helm-explorer.rollbackRelease called with item:', item);
		
		if (!item || !item.release) {
			console.log('ERROR: No release selected');
			vscode.window.showErrorMessage('No release selected');
			return;
		}
		const release = item.release;
		console.log('Release to rollback:', release);
		
		try {
			console.log('Getting release history...');
			// Get release history to show available revisions
			const history = await helmTreeProvider.getReleaseHistory(release);
			console.log('Release history:', history);
			
			if (!history || history.length === 0) {
				vscode.window.showErrorMessage('No revision history found for this release');
				return;
			}
			
			// Filter out the current revision and sort by revision number (newest first)
			const currentRevision = parseInt(release.revision);
			const availableRevisions = history
				.filter((h: any) => parseInt(h.revision) < currentRevision)
				.sort((a: any, b: any) => parseInt(b.revision) - parseInt(a.revision));
			
			if (availableRevisions.length === 0) {
				vscode.window.showWarningMessage(`Cannot rollback: No previous revisions available for "${release.name}"`);
				return;
			}
			
			const revisions = availableRevisions.map((h: any) => ({
				label: `📌 Revision ${h.revision}`,
				description: `Status: ${h.status}`,
				detail: `Updated: ${h.updated} | ${h.description || 'No description'}`,
				revision: h.revision.toString()
			}));
			
			console.log('Available revisions for rollback:', revisions);
			
			const selectedRevision = await vscode.window.showQuickPick(revisions, {
				placeHolder: `Rollback "${release.name}" from revision ${release.revision} to:`,
				title: `Rollback Helm Release: ${release.name}`,
				ignoreFocusOut: false
			});
			
			console.log('Selected revision:', selectedRevision);
			
			if (selectedRevision) {
				const confirm = await vscode.window.showWarningMessage(
					`Are you sure you want to rollback "${release.name}" from revision ${release.revision} to revision ${selectedRevision.revision}?`,
					{ modal: true },
					'Yes, Rollback'
				);
				
				console.log('User confirmation:', confirm);
				
				if (confirm === 'Yes, Rollback') {
					console.log('Calling helmTreeProvider.rollbackRelease...');
					await helmTreeProvider.rollbackRelease(release, selectedRevision.revision);
					console.log('Rollback completed');
				} else {
					console.log('User cancelled rollback');
				}
			} else {
				console.log('No revision selected - user dismissed dialog');
			}
		} catch (error: any) {
			console.log('ERROR in rollback command:', error);
			vscode.window.showErrorMessage(`Rollback failed: ${error.message}`);
		}
		
		console.log('=== HELM ROLLBACK COMMAND ENDED ===');
	}));

	context.subscriptions.push(vscode.commands.registerCommand('helm-explorer.upgradeRelease', async (item: any) => {
		if (!item || !item.release) {
			vscode.window.showErrorMessage('No release selected');
			return;
		}
		const release = item.release;
		
		// Get available chart versions
		const versions = await helmTreeProvider.getAvailableChartVersions(release);
		if (versions.length === 0) {
			vscode.window.showErrorMessage('No chart versions available');
			return;
		}
		
		// Create version selection items
		const versionItems = versions.map(version => ({
			label: version,
			description: version === release.chart.split('-')[1] ? 'Current version' : '',
			version: version
		}));
		
		const selectedVersion = await vscode.window.showQuickPick(versionItems, {
			placeHolder: `Select chart version for ${release.name} (current: ${release.chart})`,
			title: 'Upgrade Helm Release'
		});
		
		if (selectedVersion) {
			const confirm = await vscode.window.showWarningMessage(
				`Upgrade "${release.name}" to chart version ${selectedVersion.version}?`,
				{ modal: true },
				'Yes, Upgrade'
			);
			
			if (confirm === 'Yes, Upgrade') {
				await helmTreeProvider.upgradeRelease(release, selectedVersion.version);
			}
		}
	}));
}

// Keep track of open Helm release detail tabs to prevent duplicates
const openHelmReleaseTabs = new Map<string, { editor: vscode.TextEditor, revision: string }>();

// Function to clear cached tab for a specific release (used after rollback/upgrade)
function clearHelmReleaseTab(releaseName: string, namespace: string) {
	const releaseKey = `${releaseName}-${namespace}`;
	openHelmReleaseTabs.delete(releaseKey);
	console.log(`Cleared cached tab for release: ${releaseKey}`);
}

async function showEnhancedHelmReleaseDetails(release: any, helmTreeProvider: HelmTreeProvider) {
	try {
		// Create unique key for this release
		const releaseKey = `${release.name}-${release.namespace}`;
		
		// Check if tab is already open
		if (openHelmReleaseTabs.has(releaseKey)) {
			const cached = openHelmReleaseTabs.get(releaseKey)!;
			
			// Check if revision has changed (e.g., after rollback/upgrade)
			if (cached.revision !== release.revision) {
				console.log(`Revision changed for ${releaseKey}: ${cached.revision} -> ${release.revision}. Refreshing content...`);
				
				// Close the old tab first to avoid save prompts
				if (cached.editor && !cached.editor.document.isClosed) {
					const oldDocument = cached.editor.document;
					// Show the document first to ensure we can close it
					await vscode.window.showTextDocument(oldDocument, {
						viewColumn: vscode.ViewColumn.One,
						preview: false,
						preserveFocus: false
					});
					// Close the active editor (the old tab)
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
					console.log(`Closed old tab for ${releaseKey}`);
				}
				
				// Clear the cached tab so we recreate it with new data
				openHelmReleaseTabs.delete(releaseKey);
			} else if (cached.editor && !cached.editor.document.isClosed) {
				// Same revision, just switch to existing tab
				await vscode.window.showTextDocument(cached.editor.document, {
					viewColumn: vscode.ViewColumn.One,
					preview: false
				});
				return;
			} else {
				// Clean up closed tab
				openHelmReleaseTabs.delete(releaseKey);
			}
		}

		// Load all release data in parallel for better performance
		const [values, notes, history, manifest] = await Promise.all([
			helmTreeProvider.getReleaseValues(release),
			executeCommand('helm', ['get', 'notes', release.name, '--namespace', release.namespace]).then(r => r.stdout).catch(() => 'No notes available'),
			helmTreeProvider.getReleaseHistory(release),
			helmTreeProvider.getReleaseManifest(release)
		]);

		// Format time ago - return null if invalid
		const formatTimeAgo = (dateString: string) => {
			try {
				const date = new Date(dateString);
				// Check if date is valid
				if (isNaN(date.getTime())) {
					return null;
				}
				
				const now = new Date();
				const diffMs = now.getTime() - date.getTime();
				
				// Check if diffMs is valid
				if (isNaN(diffMs) || diffMs < 0) {
					return null;
				}
				
				const diffMins = Math.floor(diffMs / 60000);
				const diffHours = Math.floor(diffMs / 3600000);
				const diffDays = Math.floor(diffMs / 86400000);

				if (diffMins < 1) return 'Just now';
				if (diffMins < 60) return `${diffMins}m ago`;
				if (diffHours < 24) return `${diffHours}h ago`;
				return `${diffDays}d ago`;
			} catch (error) {
				return null;
			}
		};

		// Format the updated time
		const timeAgo = formatTimeAgo(release.updated);
		
		// Create enhanced markdown content
		const markdownContent = `# 🚀 Helm Release: **${release.name}**

## 📊 Release Information

| Property | Value |
|----------|-------|
| **📦 Chart** | \`${release.chart}\` |
| **🏷️ Namespace** | \`${release.namespace}\` |
| **📋 Status** | <span style="color: #4CAF50; font-weight: bold;">${release.status}</span> |
| **🔢 Revision** | \`${release.revision}\` |${timeAgo ? `\n| **📅 Updated** | ${timeAgo} |` : ''}
| **📱 App Version** | \`${release.appVersion}\` |

---

## 📝 Release Values

\`\`\`yaml
${values || '# No values available'}
\`\`\`

---

## 📚 Release Notes

\`\`\`text
${notes || 'No notes available for this release.'}
\`\`\`

---

## 📜 Release History

\`\`\`json
${JSON.stringify(history, null, 2)}
\`\`\`

---

## 🗂️ Release Manifest

\`\`\`yaml
${manifest || '# Manifest not available'}
\`\`\`

---

## ⚡ Quick Actions

> **💡 Tip**: Use the context menu in the Helm panel for quick actions:
> - 🔄 **Upgrade Release** - Upgrade to different chart version
> - 🔙 **Rollback Release** - Rollback to previous revision
> - 🗑️ **Uninstall Release** - Remove this release

---

*Generated by Crossplane Explorer • ${new Date().toLocaleString()}*`;

		// Create a virtual document (no file on disk)
		const doc = await vscode.workspace.openTextDocument({
			content: markdownContent,
			language: 'markdown'
		});
		
		// Show the document
		const editor = await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.One,
			preview: false
		});
		
		// Track this tab with revision info
		openHelmReleaseTabs.set(releaseKey, {
			editor: editor,
			revision: release.revision
		});
		
		// Listen for document close to clean up
		const disposable = vscode.workspace.onDidCloseTextDocument((closedDoc) => {
			if (closedDoc === doc) {
				openHelmReleaseTabs.delete(releaseKey);
				disposable.dispose();
			}
		});

	} catch (error: any) {
		vscode.window.showErrorMessage(`Failed to load release details: ${error.message}`);
	}
}

// This method is called when your extension is deactivated
export function deactivate() {}

class CrossplaneMetricsWebviewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private interval?: NodeJS.Timeout;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtmlForWebview();

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.startMetricsUpdates();
			} else {
				this.stopMetricsUpdates();
			}
		});
		if (webviewView.visible) {
			this.startMetricsUpdates();
		}
	}

	startMetricsUpdates() {
		this.stopMetricsUpdates();
		this.sendMetrics();
		this.interval = setInterval(() => this.sendMetrics(), 5000);
	}

	stopMetricsUpdates() {
		if (this.interval) clearInterval(this.interval);
	}

	async sendMetrics() {
		if (!this._view) return;
		const metrics = await new Promise<string>(resolve => {
			require('child_process').exec('crossplane beta top -s', (err: Error | null, stdout: string, stderr: string) => {
				if (err || stderr) resolve('');
				else resolve(stdout);
			});
		});
		const parsed = parseCrossplaneTopOutput(metrics);
		this._view.webview.postMessage({ type: 'metrics', data: parsed });
	}

	getHtmlForWebview(): string {
		const htmlPath = path.join(this.context.extensionPath, 'resources', 'metricsWebview.html');
		return fs.readFileSync(htmlPath, 'utf8');
	}
}

function parseCrossplaneTopOutput(output: string) {
	const lines = output.trim().split('\n');
	const summary = {
		pods: lines[0]?.split(':')[1]?.trim() || '',
		crossplane: lines[1]?.split(':')[1]?.trim() || '',
		function: lines[2]?.split(':')[1]?.trim() || '',
		provider: lines[3]?.split(':')[1]?.trim() || '',
		memory: lines[4]?.split(':')[1]?.trim() || '',
		cpu: lines[5]?.split(':')[1]?.trim() || '',
	};
	const tableStart = lines.findIndex(l => l.startsWith('TYPE'));
	const rows = [];
	for (let i = tableStart + 1; i < lines.length; i++) {
		const l = lines[i].trim();
		if (!l) continue;
		const [type, namespace, ...rest] = l.split(/\s+/);
		const name = rest.slice(0, rest.length - 2).join(' ');
		const cpu = rest[rest.length - 2];
		const memory = rest[rest.length - 1];
		let icon = '';
		if (type === 'crossplane') icon = '<span class="codicon codicon-cloud"></span>';
		else if (type === 'provider') icon = '<span class="codicon codicon-plug"></span>';
		else if (type === 'function') icon = '<span class="codicon codicon-symbol-function"></span>';
		rows.push({
			type,
			icon,
			namespace,
			name,
			nameShort: name.length > 25 ? name.slice(0, 22) + '...' : name,
			cpu,
			memory,
		});
	}
	return { summary, rows };
}

