import * as vscode from 'vscode';
import * as cp from 'child_process';
import { promisify } from 'util';
import { executeCommand } from './utils';

const exec = promisify(cp.exec);

export class CrossplaneExplorerProvider implements vscode.TreeDataProvider<CrossplaneResource> {

    private _onDidChangeTreeData: vscode.EventEmitter<CrossplaneResource | undefined | null | void> = new vscode.EventEmitter<CrossplaneResource | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CrossplaneResource | undefined | null | void> = this._onDidChangeTreeData.event;

    private allResources: any[] | null = null;
    private loading: boolean = false;

    constructor() {
    }

    refresh(): void {
        this.allResources = null;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: CrossplaneResource): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: CrossplaneResource): Promise<CrossplaneResource[]> {
        // --- PRELOAD ALL OBJECTS ON FIRST XPExplorer EXPANSION ---
        const multiResourceTypes = [
            'environmentconfigs',
            'compositions',
            'configurations',
            'deploymentruntimeconfigs',
            'compositeresourcedefinitions',
            'providers',
            'functions',
            'providerconfigs'
        ];
        if (!element) {
            // Preload all objects if not already loaded
            if (!this.allResources && !this.loading) {
                try {
                    const resourceMap: Record<string, string> = {
                        environmentconfigs: 'environmentconfigs.apiextensions.crossplane.io',
                        compositions: 'compositions.apiextensions.crossplane.io',
                        configurations: 'configurations.pkg.crossplane.io',
                        deploymentruntimeconfigs: 'deploymentruntimeconfigs.pkg.crossplane.io',
                        compositeresourcedefinitions: 'compositeresourcedefinitions.apiextensions.crossplane.io',
                        providers: 'providers.pkg.crossplane.io',
                        functions: 'functions.pkg.crossplane.io',
                        providerconfigs: 'providerconfigs'
                    };
                    const kubectlArg = Object.values(resourceMap).join(',');
                    const { stdout } = await executeCommand('kubectl', [
                        'get', kubectlArg, '-o', 'json'
                    ]);
                    const result = JSON.parse(stdout);
                    this.allResources = result.items || [];
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Error fetching resources: ${err.message}`);
                    this.allResources = [];
                } finally {
                    this.loading = false;
                }
            }
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
                const claimNodes = Array.from(claimsMap.values()).map(({ claimRef, composites }) => {
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

                // Find parent XRs (composites) with no claimRef and no ownerReferences
                const parentXRs = result.items.filter((item: any) =>
                    !item.spec?.claimRef &&
                    (!item.metadata?.ownerReferences || item.metadata.ownerReferences.length === 0)
                );
                const parentXRNodes = parentXRs.map((item: any) => {
                    const name = item.metadata.name || '';
                    const kind = item.kind || '';
                    const apiVersion = item.apiVersion || '';
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

                // Return both claim nodes and parent XR nodes
                return [...claimNodes, ...parentXRNodes];
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
        
        // --- PROVIDERCONFIGS DYNAMIC CATEGORY TREE ---
        if (element && element.label === 'providerconfigs') {
            // Discover all providerconfig resource types
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'api-resources', '--verbs=list', '--namespaced=false', '-o', 'name'
                ]);
                const lines = stdout.split('\n').filter((l: string) => l.startsWith('providerconfigs.'));
                // Map to categories
                const categories: { [key: string]: string } = {};
                for (const line of lines) {
                    if (line.includes('aws')) categories['aws'] = line;
                    else if (line.includes('azure')) categories['azure'] = line;
                    else if (line.includes('kubernetes')) categories['kubernetes'] = line;
                    else if (line.includes('tf')) categories['tf'] = line;
                    else {
                        // fallback: use the suffix after providerconfigs.
                        const suffix = line.split('providerconfigs.')[1] || 'other';
                        categories[suffix] = line;
                    }
                }
                // Return a node for each category
                return Object.keys(categories).map(cat => {
                    const node = new CrossplaneResource(cat, vscode.TreeItemCollapsibleState.Collapsed, `providerconfigs-category`, categories[cat]);
                    node.iconPath = new vscode.ThemeIcon('cloud');
                    node.contextValue = 'providerconfigs-category';
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error discovering providerconfig categories: ${err.message}`);
                return [];
            }
        }
        // Handle expanding a providerconfigs category node
        if (element && element.resourceType === 'providerconfigs-category' && element.resourceName) {
            // element.resourceName is the full resource type, e.g., providerconfigs.aws.upbound.io
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', element.resourceName, '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) return [];
                return result.items.map((item: any) => {
                    const name = item.metadata.name;
                    const label = name;
                    // Set resourceType to the full resource type for correct kubectl get
                    const node = new CrossplaneResource(label, vscode.TreeItemCollapsibleState.None, element.resourceName, name);
                    node.contextValue = 'providerconfig';
                    node.iconPath = new vscode.ThemeIcon('unfold');
                    node.command = {
                        command: 'crossplane-explorer.viewResource',
                        title: 'View Resource YAML',
                        arguments: [node]
                    };
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching providerconfigs for ${element.label}: ${err.message}`);
                return [];
            }
        }
        // --- SINGLE KUBECTL GET FOR ALL RESOURCE TYPES ---
        if (multiResourceTypes.includes(element.label === 'xrds' ? 'compositeresourcedefinitions' : element.label)) {
            // If still loading, show nothing (spinner)
            if (this.loading) {
                return [];
            }
            // Filter items for the current resource type
            let filteredItems = (this.allResources || []).filter((item: any) => {
                if (element.label === 'xrds' || element.label === 'compositeresourcedefinitions') {
                    return item.kind === 'CompositeResourceDefinition';
                }
                if (element.label === 'providerconfigs') {
                    return item.kind === 'ProviderConfig';
                }
                if (element.label === 'functions') {
                    return item.kind === 'Function';
                }
                if (element.label === 'providers') {
                    return item.kind === 'Provider';
                }
                if (element.label === 'deploymentruntimeconfigs') {
                    return item.kind === 'DeploymentRuntimeConfig';
                }
                if (element.label === 'configurations') {
                    return item.kind === 'Configuration';
                }
                if (element.label === 'compositions') {
                    return item.kind === 'Composition';
                }
                if (element.label === 'environmentconfigs') {
                    return item.kind === 'EnvironmentConfig';
                }
                return false;
            });
            if (filteredItems.length === 0) {
                return [];
            }
            // Map to CrossplaneResource nodes
            return filteredItems.map((item: any) => {
                const name = item.metadata.name;
                const namespace = item.metadata.namespace;
                const label = `${name}${namespace ? ' (' + namespace + ')' : ''}`;
                const node = new CrossplaneResource(
                    label,
                    vscode.TreeItemCollapsibleState.None,
                    element.label === 'xrds' ? 'compositeresourcedefinitions' : element.label,
                    name,
                    namespace
                );
                node.command = {
                    command: 'crossplane-explorer.viewResource',
                    title: 'View Resource YAML',
                    arguments: [node]
                };
                // Set contextValue and iconPath as before
                if (element.label === 'xrds' || element.label === 'compositeresourcedefinitions') {
                    node.contextValue = 'xrd';
                    node.iconPath = new vscode.ThemeIcon('symbol-structure');
                } else if (element.label === 'providerconfigs') {
                    node.contextValue = 'providerconfig';
                    node.iconPath = new vscode.ThemeIcon('unfold');
                } else if (element.label === 'compositions') {
                    node.contextValue = 'composition';
                } else if (element.label === 'providers') {
                    node.contextValue = 'provider';
                } else if (element.label === 'functions') {
                    node.contextValue = 'function';
                } else if (element.label === 'deploymentruntimeconfigs') {
                    node.contextValue = 'deploymentruntimeconfig';
                } else if (element.label === 'configurations') {
                    node.contextValue = 'configuration';
                } else if (element.label === 'environmentconfigs') {
                    node.contextValue = 'environmentconfig';
                }
                return node;
            });
        }
        
        // --- CROSSPLANE PODS UNDER XPExplorer ---
        if (element && element.label === 'crossplane' && !element.resourceType) {
            // Show all pods with label 'app.kubernetes.io/instance=crossplane'
            try {
                const { stdout } = await executeCommand('kubectl', [
                    'get', 'pods', '--all-namespaces',
                    '-l', 'app.kubernetes.io/instance=crossplane',
                    '-o', 'json'
                ]);
                const result = JSON.parse(stdout);
                if (!result.items || result.items.length === 0) return [];
                return result.items.map((item: any) => {
                    const name = item.metadata.name;
                    const namespace = item.metadata.namespace;
                    const node = new CrossplaneResource(name, vscode.TreeItemCollapsibleState.None, 'crossplane-pod', name, namespace);
                    node.iconPath = new vscode.ThemeIcon('package'); // Use cube icon for pods
                    node.contextValue = 'crossplane-pod';
                    node.tooltip = `${name} (${namespace})`;
                    node.command = {
                        command: 'crossplane-explorer.showPodDetails',
                        title: 'Show Pod Details',
                        arguments: [node]
                    };
                    return node;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error fetching crossplane pods: ${err.message}`);
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
        const itemLabels = ['environmentconfigs', 'compositions', 'configurations', 'deploymentruntimeconfigs', 'xrds', 'providers', 'functions', 'providerconfigs', 'crossplane', 'logs', 'deployment-flow'];
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

        // Declare iconBase once for all cases that need it
        const iconBase = require('path').join(__dirname, '..', 'resources');

        if (this.resourceName) {
            // It's a leaf node (an actual resource)
            this.iconPath = new vscode.ThemeIcon('archive');
        } else {
            // It's a category node or the root
            switch (this.label) {
                case 'XPExplorer':
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
                    this.iconPath = {
                        light: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-light.svg')),
                        dark: vscode.Uri.file(require('path').join(iconBase, 'ice-cream-stick-dark.svg'))
                    };
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