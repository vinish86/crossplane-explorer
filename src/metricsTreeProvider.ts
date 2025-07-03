import * as vscode from 'vscode';
import { exec } from 'child_process';

export class CrossplaneMetricsTreeProvider implements vscode.TreeDataProvider<MetricItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<MetricItem | undefined | void> = new vscode.EventEmitter<MetricItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<MetricItem | undefined | void> = this._onDidChangeTreeData.event;

  private metrics: MetricItem[] = [];

  constructor() {
    this.refresh();
    setInterval(() => this.refresh(), 5000); // Refresh every 5 seconds
  }

  refresh(): void {
    exec('crossplane beta top -s', (err, stdout, stderr) => {
      if (err || stderr) {
        this.metrics = [new MetricItem('Error fetching metrics', vscode.TreeItemCollapsibleState.None)];
      } else {
        this.metrics = parseMetrics(stdout);
      }
      this._onDidChangeTreeData.fire();
    });
  }

  getTreeItem(element: MetricItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: MetricItem): Thenable<MetricItem[]> {
    if (!element) {
      return Promise.resolve(this.metrics);
    }
    if (element.label === 'Cluster') {
      return new Promise(resolve => {
        exec('kubectl top nodes', (err, stdout, stderr) => {
          if (err || stderr) {
            resolve([new MetricItem('Error fetching cluster metrics', vscode.TreeItemCollapsibleState.None)]);
          } else {
            resolve(parseClusterMetrics(stdout));
          }
        });
      });
    }
    return Promise.resolve(element.children || []);
  }
}

export class MetricItem extends vscode.TreeItem {
  children?: MetricItem[];
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    children?: MetricItem[]
  ) {
    super(label, collapsibleState);
    this.children = children;
  }
}

function parseMetrics(output: string): MetricItem[] {
  const lines = output.trim().split('\n');
  const pods = lines[0]?.split(':')[1]?.trim() || '-';
  const crossplane = lines[1]?.split(':')[1]?.trim() || '-';
  const func = lines[2]?.split(':')[1]?.trim() || '-';
  const provider = lines[3]?.split(':')[1]?.trim() || '-';
  const memory = lines[4]?.split(':')[1]?.trim() || '-';
  const cpu = lines[5]?.split(':')[1]?.trim() || '-';

  // Compose two horizontal summary lines for Crossplane
  const summaryLine1 = `Pods: ${pods}   Crossplane: ${crossplane}   Function: ${func}   Providers: ${provider}`;
  const summaryLine2 = `Memory: ${memory}   CPU: ${cpu}`;

  const crossplaneSummary = [
    (() => { const i = new MetricItem(summaryLine1, vscode.TreeItemCollapsibleState.None); i.iconPath = new vscode.ThemeIcon('preview'); return i; })(),
    (() => { const i = new MetricItem(summaryLine2, vscode.TreeItemCollapsibleState.None); i.iconPath = new vscode.ThemeIcon('chip'); return i; })(),
  ];

  // Parse pod table for Crossplane
  const tableStart = lines.findIndex(l => l.startsWith('TYPE'));
  const crossplanePods: MetricItem[] = [];
  const functionPods: MetricItem[] = [];
  const providerPods: MetricItem[] = [];

  for (let i = tableStart + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    // TYPE   NAMESPACE   NAME   CPU   MEMORY
    const [type, namespace, ...rest] = l.split(/\s+/);
    let fullName = rest.slice(0, rest.length - 2).join(' ');
    const cpu = rest[rest.length - 2];
    const mem = rest[rest.length - 1];
    // Hide hash in pod name (show only base name before last dash and hash)
    let displayName = fullName.replace(/-[a-z0-9]{6,}$/i, '');
    // Truncate to first 40 characters if too long
    if (displayName.length > 40) {
      displayName = displayName.slice(0, 40) + '...';
    }
    const podItem = new MetricItem(displayName, vscode.TreeItemCollapsibleState.None);
    podItem.description = `${cpu} | ${mem}`;
    podItem.tooltip = `Pod: ${fullName}\nNamespace: ${namespace}\nCPU: ${cpu}\nMemory: ${mem}`;
    podItem.iconPath = new vscode.ThemeIcon('symbol-field');
    if (type === 'crossplane') crossplanePods.push(podItem);
    else if (type === 'function') functionPods.push(podItem);
    else if (type === 'provider') providerPods.push(podItem);
  }

  // Group nodes with icons for Crossplane
  const crossplaneNode = new MetricItem(`Crossplane (${crossplanePods.length})`, vscode.TreeItemCollapsibleState.Collapsed, crossplanePods);
  crossplaneNode.iconPath = new vscode.ThemeIcon('cloud');
  const functionNode = new MetricItem(`Function (${functionPods.length})`, vscode.TreeItemCollapsibleState.Collapsed, functionPods);
  functionNode.iconPath = new vscode.ThemeIcon('symbol-function');
  const providerNode = new MetricItem(`Providers (${providerPods.length})`, vscode.TreeItemCollapsibleState.Collapsed, providerPods);
  providerNode.iconPath = new vscode.ThemeIcon('plug');

  const podsNode = new MetricItem('Pods', vscode.TreeItemCollapsibleState.Expanded, [
    crossplaneNode,
    functionNode,
    providerNode,
  ]);
  podsNode.iconPath = new vscode.ThemeIcon('package');

  // Crossplane root node
  const crossplaneSummaryNode = new MetricItem('Crossplane', vscode.TreeItemCollapsibleState.Expanded, [
    ...crossplaneSummary,
    podsNode
  ]);
  crossplaneSummaryNode.iconPath = new vscode.ThemeIcon('cloud');

  // --- Cluster Node ---
  // We'll use a placeholder and fetch real data asynchronously
  const clusterNode = new MetricItem('Cluster', vscode.TreeItemCollapsibleState.Collapsed);
  clusterNode.iconPath = new vscode.ThemeIcon('cloud');
  clusterNode.children = [
    (() => { const i = new MetricItem('Loading...', vscode.TreeItemCollapsibleState.None); i.iconPath = new vscode.ThemeIcon('sync~spin'); return i; })()
  ];

  // Return both nodes at the root
  return [
    crossplaneSummaryNode,
    clusterNode
  ];
}

function parseClusterMetrics(output: string): MetricItem[] {
  const lines = output.trim().split('\n');
  if (lines.length < 2) return [];
  const [header, ...nodeLines] = lines;
  // Example header: NAME   CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%
  // Example node: lima-rancher-desktop   129m   6%   3162Mi   80%
  const summaryLine = nodeLines.map(l => {
    const [name, cpu, cpuPct, mem, memPct] = l.split(/\s+/);
    return `Node: ${name}   CPU: ${cpu} (${cpuPct})   Memory: ${mem} (${memPct})`;
  }).join(' | ');
  return [
    (() => { const i = new MetricItem(summaryLine, vscode.TreeItemCollapsibleState.None); i.iconPath = new vscode.ThemeIcon('preview'); return i; })(),
  ];
} 