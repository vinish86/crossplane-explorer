import * as vscode from 'vscode';
import { executeCommand } from './utils';

interface HelmRelease {
    name: string;
    namespace: string;
    revision: string;
    updated: string;
    status: string;
    chart: string;
    appVersion: string;
}

interface HelmItem {
    label: string;
    collapsibleState: vscode.TreeItemCollapsibleState;
    contextValue?: string;
    iconPath?: vscode.ThemeIcon;
    command?: vscode.Command;
    tooltip?: string;
    children?: HelmItem[];
    release?: HelmRelease;
}

export class HelmTreeProvider implements vscode.TreeDataProvider<HelmItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<HelmItem | undefined | null | void> = new vscode.EventEmitter<HelmItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<HelmItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private helmReleases: HelmRelease[] | null = null;
    private loading: boolean = false;
    private outputChannel: vscode.OutputChannel | undefined;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Helm Explorer');
    }

    refresh(): void {
        this.helmReleases = null;
        this._onDidChangeTreeData.fire();
    }

    async getChildren(element?: HelmItem): Promise<HelmItem[]> {
        if (!element) {
            // Root level - show all namespaces with releases
            if (!this.helmReleases && !this.loading) {
                this.loading = true;
                
                try {
                    const releases = await this.loadHelmReleases();
                    this.helmReleases = releases;
                    this.loading = false;
                    // Fire tree data change without clearing cache
                    this._onDidChangeTreeData.fire();
                } catch (error: any) {
                    this.outputChannel?.appendLine(`Error loading Helm releases: ${error.message}`);
                    this.helmReleases = [];
                    this.loading = false;
                    vscode.window.showErrorMessage(`Failed to load Helm releases: ${error.message}`);
                    this._onDidChangeTreeData.fire();
                }
            }
            
            if (this.loading) {
                return [new HelmItem('Loading Helm releases...', vscode.TreeItemCollapsibleState.None)];
            }

            if (!this.helmReleases || this.helmReleases.length === 0) {
                return [new HelmItem('No Helm releases found', vscode.TreeItemCollapsibleState.None)];
            }

            // Group releases by namespace
            const namespaceGroups: { [namespace: string]: HelmRelease[] } = {};
            this.helmReleases!.forEach(release => {
                if (!namespaceGroups[release.namespace]) {
                    namespaceGroups[release.namespace] = [];
                }
                namespaceGroups[release.namespace].push(release);
            });

            return Object.keys(namespaceGroups).map(namespace => {
                const releases = namespaceGroups[namespace];
                const namespaceItem = new HelmItem(
                    `${namespace} (${releases.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'helm-namespace'
                );
                namespaceItem.iconPath = new vscode.ThemeIcon('folder');
                namespaceItem.tooltip = `Namespace: ${namespace}\nReleases: ${releases.length}`;
                return namespaceItem;
            });
        }

        if (element.contextValue === 'helm-namespace') {
            // Show releases in this namespace
            const namespace = element.label.split(' (')[0];
            const releasesInNamespace = this.helmReleases!.filter(r => r.namespace === namespace);
            
            return releasesInNamespace.map(release => {
                const statusIcon = this.getStatusIcon(release.status);
                // Add revision info to contextValue to conditionally show Rollback
                const contextValue = release.revision === '1' ? 'helm-release-first' : 'helm-release';
                const releaseItem = new HelmItem(
                    release.name,
                    vscode.TreeItemCollapsibleState.None,
                    contextValue
                );
                releaseItem.iconPath = statusIcon;
                releaseItem.tooltip = this.getReleaseTooltip(release);
                releaseItem.release = release;
                // Remove the command property to make all commands available only through context menu
                
                
                return releaseItem;
            });
        }

        return [];
    }

    getTreeItem(element: HelmItem): vscode.TreeItem {
        return element;
    }


    private getStatusIcon(status: string): vscode.ThemeIcon {
        switch (status.toLowerCase()) {
            case 'deployed':
                return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            case 'pending-install':
            case 'pending-upgrade':
            case 'pending-rollback':
                return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.yellow'));
            case 'failed':
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            case 'uninstalling':
                return new vscode.ThemeIcon('trash', new vscode.ThemeColor('charts.orange'));
            case 'superseded':
                return new vscode.ThemeIcon('replace', new vscode.ThemeColor('charts.blue'));
            default:
                return new vscode.ThemeIcon('question');
        }
    }

    private getReleaseTooltip(release: HelmRelease): string {
        return `Name: ${release.name}\nNamespace: ${release.namespace}\nStatus: ${release.status}\nRevision: ${release.revision}\nChart: ${release.chart}\nApp Version: ${release.appVersion}\nUpdated: ${release.updated}`;
    }

    async refreshReleases(): Promise<void> {
        this.refresh();
    }

    private async loadHelmReleases(): Promise<HelmRelease[]> {
        try {
            const { stdout } = await executeCommand('helm', ['list', '--all-namespaces', '--output', 'json']);
            const releases = JSON.parse(stdout);
            return releases.map((release: any) => ({
                name: release.name,
                namespace: release.namespace,
                revision: release.revision.toString(),
                updated: release.updated,
                status: release.status,
                chart: release.chart,
                appVersion: release.app_version || 'N/A'
            }));
        } catch (error: any) {
            throw new Error(`Failed to load Helm releases: ${error.message}`);
        }
    }

    async getReleaseHistory(release: HelmRelease): Promise<any[]> {
        try {
            const { stdout } = await executeCommand('helm', ['history', release.name, '--namespace', release.namespace, '--output', 'json']);
            return JSON.parse(stdout);
        } catch (error: any) {
            this.outputChannel?.appendLine(`Error getting release history: ${error.message}`);
            return [];
        }
    }

    async getReleaseManifest(release: HelmRelease): Promise<string> {
        try {
            const { stdout } = await executeCommand('helm', ['get', 'manifest', release.name, '--namespace', release.namespace]);
            return stdout;
        } catch (error: any) {
            this.outputChannel?.appendLine(`Error getting release manifest: ${error.message}`);
            return '';
        }
    }

    async getReleaseValues(release: HelmRelease): Promise<string> {
        try {
            const { stdout } = await executeCommand('helm', ['get', 'values', release.name, '--namespace', release.namespace]);
            return stdout;
        } catch (error: any) {
            this.outputChannel?.appendLine(`Error getting release values: ${error.message}`);
            return '';
        }
    }

    async uninstallRelease(release: HelmRelease): Promise<void> {
        console.log('HelmTreeProvider.uninstallRelease called with:', release);
        try {
            console.log('Executing helm uninstall command...');
            await executeCommand('helm', ['uninstall', release.name, '--namespace', release.namespace]);
            console.log('Helm uninstall command completed successfully');
            vscode.window.showInformationMessage(`Successfully uninstalled Helm release: ${release.name}`);
            this.refreshReleases();
        } catch (error: any) {
            console.log('Helm uninstall command failed:', error);
            vscode.window.showErrorMessage(`Helm uninstall failed: ${error.message}`);
        }
    }

    async rollbackRelease(release: HelmRelease, revision?: string): Promise<void> {
        try {
            console.log(`=== HELM ROLLBACK EXECUTION ===`);
            console.log(`Release: ${release.name}, Namespace: ${release.namespace}, Target Revision: ${revision}`);
            
            const args = ['rollback', release.name, '--namespace', release.namespace];
            if (revision) {
                args.push(revision);
            }
            
            console.log(`Executing: helm ${args.join(' ')}`);
            const result = await executeCommand('helm', args);
            console.log(`Rollback result:`, result);
            console.log(`About to show success notification...`);
            
            // Refresh the Helm tree first
            this.refreshReleases();
            
            // Use setTimeout to ensure notification shows after all operations complete
            setTimeout(async () => {
                console.log(`Showing notification now...`);
                
                // Get the current release info after rollback to show the NEW revision
                try {
                    const currentRelease = await this.getCurrentReleaseInfo(release.name, release.namespace);
                    const newRevision = currentRelease?.revision || 'unknown';
                    
                    vscode.window.showInformationMessage(
                        `✅ Rollback Success: "${release.name}" rolled back to revision ${revision}`,
                        'View Details',
                        'OK'
                    ).then(selection => {
                        console.log(`Notification button clicked: ${selection}`);
                        if (selection === 'View Details') {
                            // Show Helm's output with rollback details
                            const output = result.stdout.trim() || 'Rollback completed successfully';
                            
                            // Create a more informative summary for rollback
                            const summary = `✅ Rollback completed successfully!\n\n` +
                                `📦 Release: ${release.name}\n` +
                                `📋 Rolled back FROM revision ${release.revision} TO revision ${revision}\n` +
                                `🆕 NEW revision after rollback: ${newRevision}\n` +
                                `🏷️ Namespace: ${release.namespace}\n` +
                                `📅 Status: Deployed\n\n` +
                                `Helm Output: ${output}`;
                            
                            vscode.window.showInformationMessage(
                                `Helm Rollback Summary:\n${summary}`,
                                { modal: true },
                                'Close'
                            );
                        }
                    });
                } catch (error) {
                    console.log(`Error getting current release info:`, error);
                    // Fallback to original notification if we can't get current info
                    vscode.window.showInformationMessage(
                        `✅ Rollback Success: "${release.name}" rolled back to revision ${revision}`,
                        'View Details',
                        'OK'
                    ).then(selection => {
                        if (selection === 'View Details') {
                            const output = result.stdout.trim() || 'Rollback completed successfully';
                            const summary = `✅ Rollback completed successfully!\n\n` +
                                `📦 Release: ${release.name}\n` +
                                `📋 Rolled back FROM revision ${release.revision} TO revision ${revision}\n` +
                                `🏷️ Namespace: ${release.namespace}\n` +
                                `📅 Status: Deployed\n\n` +
                                `Helm Output: ${output}`;
                            
                            vscode.window.showInformationMessage(
                                `Helm Rollback Summary:\n${summary}`,
                                { modal: true },
                                'Close'
                            );
                        }
                    });
                }
                
                console.log(`Notification call completed`);
            }, 100);
            
            console.log(`=== HELM ROLLBACK COMPLETED ===`);
        } catch (error: any) {
            console.log(`=== HELM ROLLBACK FAILED ===`);
            console.log(`Error:`, error);
            vscode.window.showErrorMessage(`Helm rollback failed: ${error.message}`);
        }
    }
    
    private async getCurrentReleaseInfo(releaseName: string, namespace: string): Promise<HelmRelease | null> {
        try {
            console.log(`Getting current release info for ${releaseName} in namespace ${namespace}`);
            // Use helm list with filter to find the specific release
            const { stdout } = await executeCommand('helm', ['list', '--filter', releaseName, '--namespace', namespace, '--output', 'json']);
            console.log(`Helm list output:`, stdout);
            
            const releases = JSON.parse(stdout);
            console.log(`Parsed releases:`, releases);
            
            if (releases.length > 0) {
                const release = releases[0];
                console.log(`Found release:`, release);
                return {
                    name: release.name,
                    namespace: release.namespace,
                    revision: release.revision.toString(),
                    updated: release.updated,
                    status: release.status,
                    chart: release.chart,
                    appVersion: release.app_version || 'N/A'
                };
            }
            console.log(`No releases found`);
            return null;
        } catch (error) {
            console.log(`Error getting current release info:`, error);
            // Try alternative approach - get all releases and filter
            try {
                console.log(`Trying alternative approach...`);
                const { stdout } = await executeCommand('helm', ['list', '--all-namespaces', '--output', 'json']);
                const allReleases = JSON.parse(stdout);
                const matchingRelease = allReleases.find((r: any) => r.name === releaseName && r.namespace === namespace);
                
                if (matchingRelease) {
                    console.log(`Found release via alternative approach:`, matchingRelease);
                    return {
                        name: matchingRelease.name,
                        namespace: matchingRelease.namespace,
                        revision: matchingRelease.revision.toString(),
                        updated: matchingRelease.updated,
                        status: matchingRelease.status,
                        chart: matchingRelease.chart,
                        appVersion: matchingRelease.app_version || 'N/A'
                    };
                }
            } catch (altError) {
                console.log(`Alternative approach also failed:`, altError);
            }
            return null;
        }
    }

    async upgradeRelease(release: HelmRelease, chartVersion?: string): Promise<void> {
        try {
            console.log(`=== HELM UPGRADE EXECUTION ===`);
            console.log(`Release: ${release.name}, Namespace: ${release.namespace}, Chart Version: ${chartVersion}`);
            
            // Extract chart name from the release chart (e.g., "redis-23.1.3" -> "redis")
            const chartName = release.chart.split('-')[0];
            const chartRepo = chartName === 'redis' ? 'bitnami' : 'stable'; // Default to bitnami for common charts
            
            const args = ['upgrade', release.name, `${chartRepo}/${chartName}`, '--namespace', release.namespace];
            if (chartVersion) {
                args.push('--version', chartVersion);
            }
            
            console.log(`Executing: helm ${args.join(' ')}`);
            const result = await executeCommand('helm', args);
            console.log(`Upgrade result:`, result);
            console.log(`About to show success notification...`);
            
            // Refresh the Helm tree first
            this.refreshReleases();
            
            // Use setTimeout to ensure notification shows after all operations complete
            setTimeout(() => {
                console.log(`Showing notification now...`);
                vscode.window.showInformationMessage(
                    `✅ Upgrade Success: "${release.name}" upgraded to chart version ${chartVersion || 'latest'}`,
                    'View Details',
                    'OK'
                ).then(selection => {
                    console.log(`Notification button clicked: ${selection}`);
                    if (selection === 'View Details') {
                        // Show Helm's output with upgrade details
                        const output = result.stdout.trim() || 'Upgrade completed successfully';
                        
                        // Create a more informative summary for upgrade
                        const summary = `✅ Upgrade completed successfully!\n\n` +
                            `📦 Release: ${release.name}\n` +
                            `📋 Chart Version: ${chartVersion || 'latest'}\n` +
                            `🏷️ Namespace: ${release.namespace}\n` +
                            `📅 Status: Deployed\n\n` +
                            `Helm Output: ${output}`;
                        
                        vscode.window.showInformationMessage(
                            `Helm Upgrade Summary:\n${summary}`,
                            { modal: true },
                            'Close'
                        );
                    }
                });
                console.log(`Notification call completed`);
            }, 100);
            
            console.log(`=== HELM UPGRADE COMPLETED ===`);
        } catch (error: any) {
            console.log(`=== HELM UPGRADE FAILED ===`);
            console.log(`Error:`, error);
            vscode.window.showErrorMessage(`Helm upgrade failed: ${error.message}`);
        }
    }

    async getAvailableChartVersions(release: HelmRelease): Promise<string[]> {
        try {
            // Extract chart name from the release chart (e.g., "redis-23.1.3" -> "redis")
            const chartName = release.chart.split('-')[0];
            const chartRepo = chartName === 'redis' ? 'bitnami' : 'stable'; // Default to bitnami for common charts
            
            // Search for available versions
            const { stdout } = await executeCommand('helm', ['search', 'repo', `${chartRepo}/${chartName}`, '--versions', '--output', 'json']);
            const versions = JSON.parse(stdout);
            
            // Extract and sort versions
            const versionList = versions.map((v: any) => v.version).sort((a: string, b: string) => {
                // Simple version comparison (you might want to use a proper semver library)
                return b.localeCompare(a, undefined, { numeric: true });
            });
            
            return versionList;
        } catch (error: any) {
            this.outputChannel?.appendLine(`Error getting chart versions: ${error.message}`);
            return [];
        }
    }

    dispose(): void {
        this.outputChannel?.dispose();
    }
}

class HelmItem extends vscode.TreeItem {
    public release?: HelmRelease;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        contextValue?: string
    ) {
        super(label, collapsibleState);
        this.contextValue = contextValue;
    }
}
