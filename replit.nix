# System dependencies for the Repl. Node 20 + a C toolchain so the native module
# `better-sqlite3` builds reliably if a prebuilt binary isn't available for the image.
{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.python3
    pkgs.gcc
    pkgs.gnumake
  ];
}
