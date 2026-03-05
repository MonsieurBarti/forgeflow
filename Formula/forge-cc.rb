class ForgeCc < Formula
  desc "GSD-style project orchestration for Claude Code, backed by beads"
  homepage "https://github.com/MonsieurBarti/get-shit-done-beads"
  url "https://github.com/MonsieurBarti/get-shit-done-beads/archive/refs/tags/v0.1.0.tar.gz"
  sha256 ""
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    bin.write_exec_script libexec/"install.js"
  end

  def caveats
    <<~EOS
      Run the installer to set up Forge in Claude Code:
        node #{libexec}/install.js
    EOS
  end

  test do
    system "node", libexec/"install.js", "--help"
  end
end
