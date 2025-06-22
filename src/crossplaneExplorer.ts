import * as vscode from 'vscode';
import * as cp from 'child_process';
import { promisify } from 'util';
import { executeCommand } from './utils';

const exec = promisify(cp.exec);

export class CrossplaneExplorerProvider implements vscode.TreeDataProvider<CrossplaneResource> {

    private _onDidChangeTreeData: vscode.EventEmitter<CrossplaneResource | undefined | null | void> = new vscode.EventEmitter<CrossplaneResource | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CrossplaneResource | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor() {
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: CrossplaneResource): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CrossplaneResource): Promise<CrossplaneResource[]> {
        if (!element) {
            return Promise.resolve([new CrossplaneResource('XPExplorer', vscode.TreeItemCollapsibleState.Expanded)]);
        }

        if (element.label === 'XPExplorer') {
            return Promise.resolve(this.getRootItems());
        }
        
        try {
            const resourceType = element.label;
            const { stdout, stderr } = await executeCommand('kubectl', ['get', resourceType, '-o', 'json']);
            if (stderr && !stdout) {
                vscode.window.showErrorMessage(stderr);
                return [];
            }
            const result = JSON.parse(stdout);
            if (!result.items || result.items.length === 0) {
                return [];
            }
            return result.items.map((item: any) => {
                const name = item.metadata.name;
                const namespace = item.metadata.namespace;
                
                let statusText = 'Unknown';
                if (resourceType === 'crds') {
                    statusText = item.spec?.scope || 'Unknown';
                } else if (item.status && item.status.conditions) {
                    let condition;
                    if (resourceType === 'providers' || resourceType === 'functions') {
                        condition = item.status.conditions.find((c: any) => c.type === 'Healthy');
                        if (condition) {
                            statusText = condition.status === 'True' ? 'Healthy' : 'Unhealthy';
                        }
                    } else {
                        condition = item.status.conditions.find((c: any) => c.type === 'Synced');
                        if (condition) {
                            statusText = condition.status === 'True' ? 'Synced' : 'NotSynced';
                        }
                    }
                }
                
                const label = namespace ? `${name} ${namespace} | ${statusText}` : `${name} | ${statusText}`;
                const resource = new CrossplaneResource(label, vscode.TreeItemCollapsibleState.None, resourceType, name, namespace);
                
                resource.command = {
                    command: 'crossplane-explorer.openResource',
                    title: 'Open Resource YAML',
                    arguments: [resource]
                };
                return resource;
            });
        } catch (err: any) {
            if (err instanceof Error) {
                vscode.window.showErrorMessage(`Error getting kubectl resources: ${err.message}`);
            } else {
                vscode.window.showErrorMessage(`An unknown error occurred while getting kubectl resources.`);
            }
            return [];
        }
    }

    private getRootItems(): CrossplaneResource[] {
        const itemLabels = ['managed', 'composite', 'compositions', 'claim', 'crds', 'providers', 'functions'];
        return itemLabels.map(label => new CrossplaneResource(label, vscode.TreeItemCollapsibleState.Collapsed));
    }
}

export class CrossplaneResource extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly resourceType?: string,
        public readonly resourceName?: string,
        public readonly namespace?: string
    ) {
        super(label, collapsibleState);

        if (this.resourceName) {
            // It's a leaf node (an actual resource)
            this.iconPath = new vscode.ThemeIcon('archive');
        } else {
            // It's a category node or the root
            switch (this.label) {
                case 'XPExplorer':
                    this.iconPath = new vscode.ThemeIcon('cloud');
                    break;
                case 'managed':
                    this.iconPath = new vscode.ThemeIcon('server-process');
                    break;
                case 'composite':
                    this.iconPath = new vscode.ThemeIcon('symbol-structure');
                    break;
                case 'compositions':
                    this.iconPath = new vscode.ThemeIcon('library');
                    break;
                case 'claim':
                    this.iconPath = new vscode.ThemeIcon('notebook');
                    break;
                case 'crds':
                    this.iconPath = new vscode.ThemeIcon('library');
                    break;
                case 'providers':
                    this.iconPath = new vscode.ThemeIcon('plug');
                    break;
                case 'functions':
                    this.iconPath = new vscode.ThemeIcon('symbol-function');
                    break;
            }
        }
    }
} 