"""Re-install the POSNext workspace for the unlisted-item demand records.

A patch runs once per site, and v1_12_0 has already run on sites that took the
loss-of-order build, so the workspace needs another pass to pick up the new
links. The v1_7_0 patch does the actual rebuild.
"""

from pos_next.patches.v1_7_0.reinstall_workspace import execute as reinstall_workspaces


def execute():
	reinstall_workspaces()
