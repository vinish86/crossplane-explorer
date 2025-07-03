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
            return Promise.resolve([
                new CrossplaneResource('XPExplorer', vscode.TreeItemCollapsibleState.Expanded)
            ]);
        }

        if (element.label === 'XPExplorer') {
            return Promise.resolve(this.getRootItems());
        }
        
        if (element.label === 'logs') {
            return Promise.resolve([
                new CrossplaneResource('providers', vscode.TreeItemCollapsibleState.Collapsed, 'logs-providers'),
                new CrossplaneResource('functions', vscode.TreeItemCollapsibleState.Collapsed, 'logs-functions'),
                new CrossplaneResource('crossplane', vscode.TreeItemCollapsibleState.Collapsed, 'logs-crossplane'),
            ]);
        }
        
        if (element.resourceType === 'logs-providers') {
            // List all pods with label 'pkg.crossplane.io/provider'
            try {
                const { stdout, stderr } = await executeCommand('kubectl', [
                    'get', 'pods', '--all-namespaces',
                    '-l', 'pkg.crossplane.io/provider',
                    '-o', "custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name", '--no-headers'
                ]);
                if (stderr && !stdout) {
                    vscode.window.showErrorMessage(stderr);
                    return [];
                }
                // Each line: NAMESPACE NAME
                const pods = stdout.split('\n').filter(line => line.trim().length > 0);
                return pods.map(line => {
                    const [namespace, name] = line.split(/\s+/);
                    const maxLabelLength = 24;
                    let displayName = name;
                    if (name.length > maxLabelLength) {
                        displayName = name.slice(0, maxLabelLength - 3) + '...';
                    }
                    const label = `${displayName} (${namespace})`;
                    const resource = new CrossplaneResource(label, vscode.TreeItemCollapsibleState.None, 'logs-provider-pod', name, namespace);
                    resource.iconPath = new vscode.ThemeIcon('package');
                    resource.contextValue = 'logs-provider-pod';
                    resource.tooltip = `${name} (${namespace})`;
                    resource.command = {
                        command: 'crossplane-explorer.showPodDetails',
                        title: 'Show Pod Details',
                        arguments: [resource]
                    };
                    return resource;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching provider pods: ${err.message}`);
                return [];
            }
        }
        if (element.resourceType === 'logs-functions') {
            // List all pods with label 'pkg.crossplane.io/function'
            try {
                const { stdout, stderr } = await executeCommand('kubectl', [
                    'get', 'pods', '--all-namespaces',
                    '-l', 'pkg.crossplane.io/function',
                    '-o', "custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name", '--no-headers'
                ]);
                if (stderr && !stdout) {
                    vscode.window.showErrorMessage(stderr);
                    return [];
                }
                // Each line: NAMESPACE NAME
                const pods = stdout.split('\n').filter(line => line.trim().length > 0);
                return pods.map(line => {
                    const [namespace, name] = line.split(/\s+/);
                    const maxLabelLength = 24;
                    let displayName = name;
                    if (name.length > maxLabelLength) {
                        displayName = name.slice(0, maxLabelLength - 3) + '...';
                    }
                    const label = `${displayName} (${namespace})`;
                    const resource = new CrossplaneResource(label, vscode.TreeItemCollapsibleState.None, 'logs-function-pod', name, namespace);
                    resource.iconPath = new vscode.ThemeIcon('package');
                    resource.contextValue = 'logs-provider-pod';
                    resource.tooltip = `${name} (${namespace})`;
                    resource.command = {
                        command: 'crossplane-explorer.showPodDetails',
                        title: 'Show Pod Details',
                        arguments: [resource]
                    };
                    return resource;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching function pods: ${err.message}`);
                return [];
            }
        }
        if (element.resourceType === 'logs-crossplane') {
            // List all pods with label 'release=crossplane'
            try {
                const { stdout, stderr } = await executeCommand('kubectl', [
                    'get', 'pods', '--all-namespaces',
                    '-l', 'release=crossplane',
                    '-o', "custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name", '--no-headers'
                ]);
                if (stderr && !stdout) {
                    vscode.window.showErrorMessage(stderr);
                    return [];
                }
                // Each line: NAMESPACE NAME
                const pods = stdout.split('\n').filter(line => line.trim().length > 0);
                return pods.map(line => {
                    const [namespace, name] = line.split(/\s+/);
                    const maxLabelLength = 24;
                    let displayName = name;
                    if (name.length > maxLabelLength) {
                        displayName = name.slice(0, maxLabelLength - 3) + '...';
                    }
                    const label = `${displayName} (${namespace})`;
                    const resource = new CrossplaneResource(label, vscode.TreeItemCollapsibleState.None, 'logs-crossplane-pod', name, namespace);
                    resource.iconPath = new vscode.ThemeIcon('package');
                    resource.contextValue = 'logs-provider-pod';
                    resource.tooltip = `${name} (${namespace})`;
                    resource.command = {
                        command: 'crossplane-explorer.showPodDetails',
                        title: 'Show Pod Details',
                        arguments: [resource]
                    };
                    return resource;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching crossplane pods: ${err.message}`);
                return [];
            }
        }
        if (element.resourceType && element.resourceType.startsWith('logs-')) {
            return Promise.resolve([]);
        }
        
        if (element.label === 'claim') {
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', 'claim', '--all-namespaces', '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) {
                    return [];
                }
                return result.items.map((item: any) => {
                    const kind = item.kind;
                    const apiVersion = item.apiVersion || '';
                    const group = apiVersion.split('/')[0] || '';
                    const resourceType = group ? `${kind.toLowerCase()}.${group}` : kind.toLowerCase();
                    const name = item.metadata.name;
                    const namespace = item.metadata.namespace;
                    const label = `[claim] | ${resourceType} | ${name} | ${namespace}`;
                    const node = new CrossplaneResource(
                        label,
                        vscode.TreeItemCollapsibleState.None,
                        resourceType,
                        name,
                        namespace
                    );
                    node.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [node]
                    };
                    console.log('[DEBUG] Set .command for claim node:', {
                        label,
                        resourceType,
                        name,
                        namespace
                    });
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching claims: ${err.message}`);
                return [];
            }
        }
        if (element.label === 'deployment-flow') {
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', 'composite', '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) return [];

                // Group composites by claimRef (only those with claimRef)
                const claimsMap = new Map<string, { claimRef: any, composites: any[] }>();
                for (const item of result.items) {
                    const claimRef = item.spec?.claimRef;
                    if (claimRef && claimRef.name && claimRef.kind && claimRef.namespace) {
                        const kind = claimRef.kind;
                        const apiVersion = claimRef.apiVersion || '';
                        const group = apiVersion.split('/')[0] || '';
                        const resourceType = group ? `${kind.toLowerCase()}.${group}` : kind.toLowerCase();
                        const name = claimRef.name;
                        const namespace = claimRef.namespace;
                        const claimKey = `${resourceType}|${name}|${namespace}`;
                        if (!claimsMap.has(claimKey)) {
                            claimsMap.set(claimKey, { claimRef, composites: [] });
                        }
                        claimsMap.get(claimKey)!.composites.push(item);
                    }
                }

                // Create claim nodes at the root (only those referenced by a composite)
                return Array.from(claimsMap.values()).map(({ claimRef, composites }) => {
                    const kind = claimRef.kind;
                    const apiVersion = claimRef.apiVersion || '';
                    const group = apiVersion.split('/')[0] || '';
                    const resourceType = group ? `${kind.toLowerCase()}.${group}` : kind.toLowerCase();
                    const name = claimRef.name;
                    const namespace = claimRef.namespace;
                    const label = `[claim] | ${resourceType} | ${name} | ${namespace}`;
                    const claimNode = new CrossplaneResource(
                        label,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        resourceType,
                        name,
                        namespace
                    );
                    claimNode.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [claimNode]
                    };
                    claimNode.contextValue = 'deployment-flow-claim';
                    (claimNode as any)._childComposites = composites;
                    return claimNode;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching composites: ${err.message}`);
                return [];
            }
        }
        // For expanding child XRs/MRs under deployment-flow claim nodes
        if (element.contextValue === 'deployment-flow-claim') {
            // Show all top-level XRs for this claim
            const composites = (element as any)._childComposites || [];
            return composites.map((composite: any) => {
                const name = composite.metadata.name || '';
                const kind = composite.kind || '';
                const apiVersion = composite.apiVersion || '';
                const group = apiVersion.split('/')[0] || '';
                const resourceType = group ? `${kind.toLowerCase()}.${group}` : kind.toLowerCase();
                const label = `[XR] | ${kind} | ${name}`;
                const node = new CrossplaneResource(
                    label,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    resourceType,
                    name,
                    '' // composites are cluster-scoped
                );
                node.contextValue = 'composite-xr';
                node.command = {
                    command: 'crossplane-explorer.viewResource',
                    title: 'View Resource YAML',
                    arguments: [node]
                };
                return node;
            });
        }
        // Komoplane-style composite expansion logic (for XR children)
        if (element.resourceType && (element.resourceType.startsWith('x') || element.resourceType.startsWith('composite'))) {
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', element.resourceType, (element.resourceName ? element.resourceName : ''), '-o', 'json'
                ]);
                const composite = JSON.parse(stdout);
                const resourceRefs = composite.spec?.resourceRefs || [];
                return resourceRefs.map((ref: any) => {
                    const isComposite = ref.kind && ref.kind.startsWith('X');
                    const group = (ref.apiVersion || '').split('/')[0];
                    const resourceType = group ? `${ref.kind.toLowerCase()}.${group}` : ref.kind.toLowerCase();
                    const label = isComposite
                        ? `[XR] | ${ref.kind} | ${ref.name}`
                        : `[MR] | ${ref.kind} | ${ref.name}`;
                    const resource = new CrossplaneResource(
                        label,
                        isComposite ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                        resourceType,
                        (ref.name ? ref.name : ''),
                        isComposite ? '' : (ref.namespace ? ref.namespace : '')
                    );
                    resource.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [resource]
                    };
                    // Set contextValue for Field Watch menu
                    if (isComposite) {
                        resource.contextValue = 'composite-xr';
                    } else {
                        resource.contextValue = 'managed-resource';
                    }
                    return resource;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching composite children: ${err.message}`);
                return [];
            }
        }
        
        if (element.label === 'configurations') {
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', 'configurations.pkg.crossplane.io', '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) {
                    return [];
                }
                return result.items.map((item: any) => {
                    const name = item.metadata.name;
                    const namespace = item.metadata.namespace;
                    const label = `${name}${namespace ? ' (' + namespace + ')' : ''}`;
                    const node = new CrossplaneResource(
                        label,
                        vscode.TreeItemCollapsibleState.None,
                        'configurations.pkg.crossplane.io',
                        name,
                        namespace
                    );
                    node.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [node]
                    };
                    node.contextValue = 'configuration';
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching configurations: ${err.message}`);
                return [];
            }
        }
        
        if (element.label === 'deploymentruntimeconfigs') {
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', 'deploymentruntimeconfigs.pkg.crossplane.io', '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) {
                    return [];
                }
                return result.items.map((item: any) => {
                    const name = item.metadata.name;
                    const namespace = item.metadata.namespace;
                    const label = `${name}${namespace ? ' (' + namespace + ')' : ''}`;
                    const node = new CrossplaneResource(
                        label,
                        vscode.TreeItemCollapsibleState.None,
                        'deploymentruntimeconfigs.pkg.crossplane.io',
                        name,
                        namespace
                    );
                    node.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [node]
                    };
                    node.contextValue = 'deploymentruntimeconfig';
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching deploymentruntimeconfigs: ${err.message}`);
                return [];
            }
        }
        
        if (element.label === 'environmentconfigs') {
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', 'environmentconfigs.apiextensions.crossplane.io', '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) {
                    return [];
                }
                return result.items.map((item: any) => {
                    const name = item.metadata.name;
                    const namespace = item.metadata.namespace;
                    const label = `${name}${namespace ? ' (' + namespace + ')' : ''}`;
                    const node = new CrossplaneResource(
                        label,
                        vscode.TreeItemCollapsibleState.None,
                        'environmentconfigs.apiextensions.crossplane.io',
                        name,
                        namespace
                    );
                    node.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [node]
                    };
                    node.contextValue = 'environmentconfig';
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching environmentconfigs: ${err.message}`);
                return [];
            }
        }
        
        if (element.label === 'providerconfigs') {
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', 'providerconfigs', '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) {
                    return [];
                }
                return result.items.map((item: any) => {
                    const name = item.metadata.name;
                    const namespace = item.metadata.namespace;
                    const label = `${name}${namespace ? ' (' + namespace + ')' : ''}`;
                    const node = new CrossplaneResource(
                        label,
                        vscode.TreeItemCollapsibleState.None,
                        'providerconfigs',
                        name,
                        namespace
                    );
                    node.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [node]
                    };
                    node.contextValue = 'providerconfig';
                    node.iconPath = new vscode.ThemeIcon('unfold');
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching providerconfigs: ${err.message}`);
                return [];
            }
        }
        
        if (element.label === 'compositions') {
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', 'compositions', '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) {
                    return [];
                }
                return result.items.map((item: any) => {
                    const name = item.metadata.name;
                    const namespace = item.metadata.namespace;
                    const label = `${name}${namespace ? ' (' + namespace + ')' : ''}`;
                    const node = new CrossplaneResource(
                        label,
                        vscode.TreeItemCollapsibleState.None,
                        'compositions',
                        name,
                        namespace
                    );
                    node.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [node]
                    };
                    node.contextValue = 'composition';
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching compositions: ${err.message}`);
                return [];
            }
        }
        
        if (element.label === 'xrds') {
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', 'xrds', '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) {
                    return [];
                }
                return result.items.map((item: any) => {
                    const name = item.metadata.name;
                    const node = new CrossplaneResource(
                        name,
                        vscode.TreeItemCollapsibleState.None,
                        'xrd',
                        name
                    );
                    node.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [node]
                    };
                    node.contextValue = 'xrd';
                    node.iconPath = new vscode.ThemeIcon('symbol-structure');
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching xrds: ${err.message}`);
                return [];
            }
        }
        
        try {
            const resourceType = element.label;
            let args = ['get', resourceType, '-o', 'json'];
            if (resourceType === 'crds') {
                args = ['get', resourceType, '--all-namespaces', '-o', 'json'];
            }
            if (resourceType === 'functions') {
                args = ['get', 'functions.pkg.crossplane.io', '--all-namespaces', '-o', 'json'];
            }
            const { stdout, stderr } = await executeCommand('kubectl', args);
            if (stderr && !stdout) {
                vscode.window.showErrorMessage(stderr);
                return [];
            }
            const result = JSON.parse(stdout);
            if (!result.items || result.items.length === 0) {
                return [];
            }
            const config = vscode.workspace.getConfiguration('crossplaneExplorer');
            const excludeSuffixes: string[] = config.get('excludeCrdSuffixes', ["crossplane.io", "upbound.io", "cattle.io"]);
            return result.items
                .filter((item: any) => {
                    if (resourceType === 'crds') {
                        const name = item.metadata.name;
                        return !excludeSuffixes.some(suffix => name.endsWith(suffix));
                    }
                    return true;
                })
                .map((item: any) => {
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
                    
                    let fullResourceType = resourceType;
                    let displayKind = '';
                    if (resourceType === 'composite' || resourceType === 'claim' || resourceType === 'managed') {
                        const apiVersion = item.apiVersion;
                        const kind = item.kind;
                        const group = apiVersion.split('/')[0];
                        fullResourceType = `${kind.toLowerCase()}.${group}`;
                        displayKind = `${kind}.${group}`;
                    }
                    // Special handling for CRDs
                    let crdResourceType = fullResourceType;
                    if (resourceType === 'crds') {
                        crdResourceType = 'crd';
                    }
                    const label = (resourceType === 'composite' || resourceType === 'claim' || resourceType === 'managed')
                        ? (namespace ? `${displayKind} | ${name} ${namespace} | ${statusText}` : `${displayKind} | ${name} | ${statusText}`)
                        : (namespace ? `${name} ${namespace} | ${statusText}` : `${name} | ${statusText}`);
                    const resource = new CrossplaneResource(label, vscode.TreeItemCollapsibleState.None, crdResourceType, name, namespace);
                    if (name) {
                        resource.command = {
                            command: 'crossplane-explorer.viewResource',
                            title: 'View Resource YAML',
                            arguments: [resource]
                        };
                    }
                    if (resourceType === 'providers') {
                        resource.contextValue = 'provider';
                    } else if (resourceType === 'functions') {
                        resource.contextValue = 'function';
                    }
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
        const itemLabels = ['environmentconfigs', 'compositions', 'configurations', 'deploymentruntimeconfigs', 'xrds', 'providers', 'functions', 'providerconfigs', 'logs', 'deployment-flow'];
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
                    const iconBase = require('path').join(__dirname, '..', 'resources');
                    this.iconPath = {
                        light: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-light.svg')),
                        dark: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-dark.svg'))
                    };
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
                case 'configurations':
                    this.iconPath = new vscode.ThemeIcon('gear');
                    break;
                case 'deploymentruntimeconfigs':
                    this.iconPath = new vscode.ThemeIcon('settings-editor-label-icon');
                    break;
                case 'environmentconfigs':
                    this.iconPath = new vscode.ThemeIcon('variable');
                    break;
                case 'crds':
                    this.iconPath = new vscode.ThemeIcon('symbol-structure');
                    break;
                case 'providers':
                    this.iconPath = new vscode.ThemeIcon('plug');
                    break;
                case 'functions':
                    this.iconPath = new vscode.ThemeIcon('symbol-function');
                    break;
                case 'logs':
                    this.iconPath = new vscode.ThemeIcon('output');
                    break;
                case 'providers':
                    if (this.resourceType && this.resourceType.startsWith('logs-')) {
                        this.iconPath = new vscode.ThemeIcon('plug');
                    }
                    break;
                case 'functions':
                    if (this.resourceType && this.resourceType.startsWith('logs-')) {
                        this.iconPath = new vscode.ThemeIcon('symbol-function');
                    }
                    break;
                case 'crossplane':
                    if (this.resourceType && this.resourceType.startsWith('logs-')) {
                        const iconBase = require('path').join(__dirname, '..', 'resources');
                        this.iconPath = {
                            light: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-light.svg')),
                            dark: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-dark.svg'))
                        };
                    }
                    break;
                case 'providerconfigs':
                    this.iconPath = new vscode.ThemeIcon('unfold');
                    break;
                case 'xrds':
                    this.iconPath = new vscode.ThemeIcon('symbol-structure');
                    break;
            }
        }
    }
} 