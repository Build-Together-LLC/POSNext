"""Re-install the POSNext workspace so existing sites pick up the Loss of Order
records and the demand-vs-actual report.

The v1_7_0 patch already rebuilds every workspace from its JSON; this only needs
to run it again now that the JSON has changed.
"""

from pos_next.patches.v1_7_0.reinstall_workspace import execute as reinstall_workspaces


def execute():
	reinstall_workspaces()
