' Runs "Start Claude Pulse.cmd" without flashing a console window. Used by the Windows Startup shortcut.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & here & "\Start Claude Pulse.cmd""", 0, False
