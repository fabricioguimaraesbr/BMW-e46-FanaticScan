#!/usr/bin/perl
# Junta os arquivos da pasta "modulos" ao programa (E46Fanatics-Scan-completo.html).
# Chamado pelo "Abrir no Mac.command" (sem argumentos) e pelo "E46Fanatics Scan.app"
# (argumentos: programa base, pasta dos modulos, pasta onde gravar o resultado).
# Sai com 0 quando ha arquivos de modulos, 1 quando a pasta esta vazia.
use strict;
use warnings;
use File::Basename qw(dirname);
use File::Spec;
use Cwd qw(abs_path);
use IO::Compress::Gzip qw(gzip $GzipError);
use MIME::Base64 qw(encode_base64);

my $app   = dirname(abs_path($0));
my $base  = $ARGV[0] // File::Spec->catfile($app, 'E46Fanatics-Scan.html');
my $mods  = $ARGV[1] // File::Spec->catdir(dirname($app), 'modulos');
my $dest  = $ARGV[2] // $app;
my $out   = File::Spec->catfile($dest, 'E46Fanatics-Scan-completo.html');
my $stampFile = File::Spec->catfile($dest, 'completo.stamp');

opendir(my $dh, $mods) or exit 1;
my @files = sort grep { /\.(prg|grp)$/i && -f File::Spec->catfile($mods, $_) } readdir($dh);
closedir($dh);
exit 1 unless @files;

sub slurp { my ($p) = @_; open(my $fh, '<:raw', $p) or die "$p: $!"; local $/; my $d = <$fh>; close $fh; return $d; }

my @st = map { my @s = stat(File::Spec->catfile($mods, $_)); "$_|$s[7]|$s[9]" } @files;
my $stamp = join(';', @st) . ';' . (stat($base))[9];
if (-f $out && -f $stampFile && slurp($stampFile) eq $stamp) { exit 0; }

my (@entries, $body);
$body = '';
for my $f (@files) {
  my $d = slurp(File::Spec->catfile($mods, $f));
  (my $n = lc $f) =~ s/(["\\])/\\$1/g;
  push @entries, "[\"$n\"," . length($d) . "]";
  $body .= $d;
}
my $head = '[' . join(',', @entries) . ']';
my $raw = pack('V', length $head) . $head . $body;
my $gz;
gzip(\$raw => \$gz, -Level => 9) or die "gzip: $GzipError";
my $b64 = encode_base64($gz, '');

my $html = slurp($base);
my $i = rindex($html, '</body>');
$i = length $html if $i < 0;
substr($html, $i, 0) = '<script id="ecu-bundle" type="application/octet-stream">' . $b64 . '</script>';
open(my $o, '>:raw', $out) or die "$out: $!"; print $o $html; close $o;
open(my $s, '>:raw', $stampFile) or die; print $s $stamp; close $s;
exit 0;
