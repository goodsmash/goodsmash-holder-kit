// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A free mint whose name/symbol are HTML. The UI must render them as text.
contract EvilName {
    string public name = "<img src=x onerror=\"window.__hkXss=1\">Evil";
    string public symbol = "<b>X</b>";
    uint256 public mintPrice;
    uint256 public maxSupply = 100;
    uint256 public totalMinted;
    bool public saleIsActive = true;
    mapping(address => uint256) public balanceOf;

    function mint(uint256 qty) external payable {
        require(saleIsActive, "inactive");
        require(totalMinted + qty <= maxSupply, "sold out");
        totalMinted += qty;
        balanceOf[msg.sender] += qty;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd || id == 0x01ffc9a7;
    }
}
