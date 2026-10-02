// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
}

/// Minimal enumerable ERC-721 used only by the holder-kit test suite.
contract MockRigs is IERC721 {
    string public name = "Mock RIGS";
    string public symbol = "RIG";
    uint256 public totalSupply;
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(address => uint256[]) private _tokensOf;
    mapping(uint256 => uint256) private _indexOf;

    function mint(address to, uint256 qty) external {
        for (uint256 i = 0; i < qty; i++) {
            uint256 id = ++totalSupply;
            _ownerOf[id] = to;
            _indexOf[id] = _tokensOf[to].length;
            _tokensOf[to].push(id);
            _balanceOf[to] += 1;
        }
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balanceOf[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _ownerOf[tokenId];
        require(o != address(0), "nonexistent");
        return o;
    }

    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256) {
        return _tokensOf[owner][index];
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "not owner");
        _ownerOf[tokenId] = to;
        _balanceOf[from] -= 1;
        _balanceOf[to] += 1;
        _indexOf[tokenId] = _tokensOf[to].length;
        _tokensOf[to].push(tokenId);
    }

    /// Real ERC-721s expose safeTransferFrom; the kit calls it, so the mock must too.
    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(_ownerOf[tokenId] == from, "not owner");
        require(to != address(0), "to zero");
        _ownerOf[tokenId] = to;
        _balanceOf[from] -= 1;
        _balanceOf[to] += 1;
        _indexOf[tokenId] = _tokensOf[to].length;
        _tokensOf[to].push(tokenId);
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function setApprovalForAll(address, bool) external pure returns (bool) {
        return true;
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return true;
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true; // ERC-721 = 0x80ac58cd, ERC-1155 = 0xd9b67a26
    }
}
