<#
  pick-folder.ps1 — open the modern Windows folder picker, print the chosen path.

  Why this exists rather than a one-liner:

  System.Windows.Forms.FolderBrowserDialog is the OLD tree-style dialog on
  Windows PowerShell 5.1. It only becomes the modern Explorer-style picker on
  .NET Core 3.0+, i.e. PowerShell 7 — which is not installed here. So we call
  IFileOpenDialog with FOS_PICKFOLDERS directly, which is what Microsoft has
  recommended over SHBrowseForFolder since Vista.

  Contract, relied on by server.js:
    - picked   -> one absolute path on stdout, UTF-8, trailing newline
    - cancelled-> nothing on stdout, exit code 0
    - failure  -> message on stderr, exit code 1

  Must run STA (PowerShell 3.0+ already does; asserted below).
#>

$ErrorActionPreference = 'Stop'

# Paths here carry spaces, parens and the occasional non-ASCII character.
# Without this the console codepage mangles them on the way to Node.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
  [Console]::Error.WriteLine('pick-folder: needs -STA (COM dialogs cannot run MTA)')
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms

Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;

namespace DocsCanvas
{
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    // IFileDialog. The method order below IS the vtable — do not reorder or
    // omit anything, including methods we never call.
    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);                 // IModalWindow
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, uint fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close([MarshalAs(UnmanagedType.Error)] int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    internal class FileOpenDialogRCW { }

    public static class FolderPicker
    {
        const uint FOS_PICKFOLDERS     = 0x00000020;
        const uint FOS_FORCEFILESYSTEM = 0x00000040;  // no virtual shell junk
        const uint FOS_PATHMUSTEXIST   = 0x00000800;
        const uint SIGDN_FILESYSPATH   = 0x80058000;
        const int  ERROR_CANCELLED     = unchecked((int)0x800704C7);

        /// Returns the chosen path, or null if the user cancelled.
        public static string Pick(IntPtr owner, string title)
        {
            IFileDialog dlg = (IFileDialog)(new FileOpenDialogRCW());
            uint opts;
            dlg.GetOptions(out opts);
            dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            if (!String.IsNullOrEmpty(title)) dlg.SetTitle(title);

            int hr = dlg.Show(owner);
            if (hr == ERROR_CANCELLED) return null;
            if (hr != 0) throw new COMException("IFileOpenDialog.Show failed", hr);

            IShellItem item;
            dlg.GetResult(out item);
            string path;
            item.GetDisplayName(SIGDN_FILESYSPATH, out path);
            return path;
        }
    }
}
'@

# The dialog is opened by a background process, so without an owner it can
# surface *behind* the browser. A topmost zero-size form gives it one.
$anchor = New-Object System.Windows.Forms.Form
$anchor.TopMost         = $true
$anchor.ShowInTaskbar   = $false
$anchor.FormBorderStyle = 'None'
$anchor.Size            = New-Object System.Drawing.Size(1, 1)
$anchor.Opacity         = 0
$anchor.StartPosition   = 'CenterScreen'

try {
  $anchor.Show()
  $anchor.Activate()
  [System.Windows.Forms.Application]::DoEvents()

  # Diagnostics go to stderr only — stdout stays the clean one-path contract,
  # so this is safe to leave in permanently and tells us "cancelled" apart
  # from "the dialog never opened".
  [Console]::Error.WriteLine('pick-folder: showing dialog')
  $picked = [DocsCanvas.FolderPicker]::Pick($anchor.Handle, 'Choose a folder for the canvas')
  if ($picked) {
    [Console]::Error.WriteLine('pick-folder: picked')
    [Console]::Out.WriteLine($picked)
  } else {
    [Console]::Error.WriteLine('pick-folder: cancelled')
  }
  exit 0
}
catch {
  [Console]::Error.WriteLine("pick-folder: $($_.Exception.Message)")
  exit 1
}
finally {
  $anchor.Close()
  $anchor.Dispose()
}
